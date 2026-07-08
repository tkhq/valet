import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle, SandboxAlreadyExitedError, SandboxSnapshotFailedError } from './session-lifecycle.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SessionLifecycle.snapshotSandbox', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function makeLifecycle() {
    const state = {
      sandboxId: 'sb-123',
      hibernateUrl: 'https://backend/hibernate',
    } as any;
    return new SessionLifecycle(state, {} as DurableObjectState);
  }

  it('maps 409 already-finished responses to SandboxAlreadyExitedError', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'sandbox_already_finished' }), { status: 409 }),
    );

    await expect(makeLifecycle().snapshotSandbox()).rejects.toBeInstanceOf(SandboxAlreadyExitedError);
  });

  it('surfaces backend snapshot failures with a distinct error message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'snapshot_failed', message: 'Failed to create image' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(makeLifecycle().snapshotSandbox()).rejects.toThrow(
      'Snapshot failed: Failed to create image',
    );
  });

  it('maps Modal snapshot timeout 500 responses to snapshot failures', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        "modal-http: internal error: status Failure: ExecutionError('Timed out waiting for image to be created')\n",
        { status: 500, headers: { 'Content-Type': 'text/plain' } },
      ),
    );

    const snapshot = makeLifecycle().snapshotSandbox();

    await expect(snapshot).rejects.toBeInstanceOf(SandboxSnapshotFailedError);
    await expect(snapshot).rejects.toThrow(
      'Snapshot failed: Timed out waiting for image to be created',
    );
  });
});

describe('SessionLifecycle.spawnSandbox (TKAI-176 retry)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  function makeLifecycle() {
    const state = {} as any;
    return new SessionLifecycle(state, {} as DurableObjectState);
  }

  it('returns success on first attempt without retrying', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ sandboxId: 'sb-123', tunnelUrls: { app: 'https://app' } }),
        { status: 200 },
      ),
    );

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', { foo: 'bar' });
    await vi.runAllTimersAsync();
    const result = await spawn;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.sandboxId).toBe('sb-123');
    expect(result.tunnelUrls).toEqual({ app: 'https://app' });
  });

  it('retries once on 524 Cloudflare edge timeout, then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('error code: 524', { status: 524 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sandboxId: 'sb-retry', tunnelUrls: {} }),
          { status: 200 },
        ),
      );

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', {});
    await vi.runAllTimersAsync();
    const result = await spawn;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.sandboxId).toBe('sb-retry');
  });

  it('retries on 503 backend-unavailable, then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('cold start', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sandboxId: 'sb-cold', tunnelUrls: {} }),
          { status: 200 },
        ),
      );

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', {});
    await vi.runAllTimersAsync();
    const result = await spawn;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.sandboxId).toBe('sb-cold');
  });

  it('fails fast on 4xx without retrying', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('bad request', { status: 400 }),
    );

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', {});
    // Attach the rejection assertion BEFORE running timers so vitest tracks it
    // as handled (avoids PromiseRejectionHandledWarning).
    const assertion = expect(spawn).rejects.toThrow(/Backend returned 400/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces the last error after exhausting retries on repeated 524', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('error code: 524', { status: 524 }))
      .mockResolvedValueOnce(new Response('error code: 524', { status: 524 }));

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', {});
    const assertion = expect(spawn).rejects.toThrow(/Backend returned 524/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on AbortError (fetch timeout) and succeeds', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    mockFetch
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sandboxId: 'sb-abort-retry', tunnelUrls: {} }),
          { status: 200 },
        ),
      );

    const spawn = makeLifecycle().spawnSandbox('https://backend/create', {});
    await vi.runAllTimersAsync();
    const result = await spawn;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.sandboxId).toBe('sb-abort-retry');
  });
});

describe('SessionLifecycle.scheduleAlarm', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('clamps past deadlines to at least 30s in the future', () => {
    const setAlarm = vi.fn();
    const state = {
      idleTimeoutMs: 0,
      lastUserActivityAt: 0,
    } as any;
    const ctx = { storage: { setAlarm } } as unknown as DurableObjectState;
    const lifecycle = new SessionLifecycle(state, ctx);

    const pastDeadline = Date.now() - 60_000; // 1 minute ago
    lifecycle.scheduleAlarm([pastDeadline]);

    expect(setAlarm).toHaveBeenCalledTimes(1);
    const scheduledTime = setAlarm.mock.calls[0][0] as number;
    // Should be at least 29s in the future (allowing 1s for test execution)
    expect(scheduledTime).toBeGreaterThan(Date.now() + 29_000);
    expect(scheduledTime).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('does not clamp future deadlines', () => {
    const setAlarm = vi.fn();
    const state = {
      idleTimeoutMs: 0,
      lastUserActivityAt: 0,
    } as any;
    const ctx = { storage: { setAlarm } } as unknown as DurableObjectState;
    const lifecycle = new SessionLifecycle(state, ctx);

    const futureDeadline = Date.now() + 120_000; // 2 minutes from now
    lifecycle.scheduleAlarm([futureDeadline]);

    expect(setAlarm).toHaveBeenCalledWith(futureDeadline);
  });
});
