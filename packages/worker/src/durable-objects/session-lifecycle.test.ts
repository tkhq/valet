import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SessionLifecycle, SandboxAlreadyExitedError, SandboxSnapshotFailedError } from './session-lifecycle.js';
import { SessionState } from './session-state.js';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * SessionState with the SQLite layer swapped for a Map, so fixtures go through
 * the real typed getters/setters instead of `as any` state bags.
 */
class FakeSessionState extends SessionState {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    // The SqlStorage is never touched: get/set below bypass the SQL layer.
    super({} as SqlStorage);
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  override get(key: string): string | undefined {
    return this.values.get(key);
  }

  override set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeAlarmCtx(): { ctx: DurableObjectState; alarms: number[] } {
  const alarms: number[] = [];
  const storage: Pick<DurableObjectStorage, 'setAlarm'> = {
    setAlarm: async (time) => {
      alarms.push(time instanceof Date ? time.getTime() : time);
    },
  };
  // scheduleAlarm only touches storage.setAlarm; bridge the partial to the platform type.
  return { ctx: { storage } as DurableObjectState, alarms };
}

/** Headers of the first (and only) fetch the test triggered. */
function sentHeaders(): Headers {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionLifecycle.snapshotSandbox', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function makeLifecycle() {
    const state = new FakeSessionState({
      sandboxId: 'sb-123',
      hibernateUrl: 'https://backend/hibernate',
    });
    // ctx is untouched by the HTTP methods; single-cast bridges the unused platform type.
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

describe('SessionLifecycle traceparent propagation', () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function makeLifecycle() {
    // ctx is untouched by the HTTP methods; single-cast bridges the unused platform type.
    return new SessionLifecycle(new FakeSessionState(), {} as DurableObjectState);
  }

  it('sends a traceparent header on backend fetches when a span is active', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ sandboxId: 'sb-1', tunnelUrls: {} }), { status: 200 }),
    );

    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      try {
        await makeLifecycle().spawnSandbox('https://backend/create', { sessionId: 's1' });
        const sc = span.spanContext();
        expect(sentHeaders().get('traceparent')).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
        expect(sentHeaders().get('content-type')).toBe('application/json');
      } finally {
        span.end();
      }
    });
  });

  it('omits the traceparent header when no span is active', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ sandboxId: 'sb-1', tunnelUrls: {} }), { status: 200 }),
    );

    await makeLifecycle().spawnSandbox('https://backend/create', { sessionId: 's1' });

    expect(sentHeaders().get('traceparent')).toBeNull();
    expect(sentHeaders().get('content-type')).toBe('application/json');
  });
});

describe('SessionLifecycle.scheduleAlarm', () => {
  it('clamps past deadlines to at least 30s in the future', () => {
    const { ctx, alarms } = makeAlarmCtx();
    const state = new FakeSessionState({ idleTimeoutMs: '0', lastUserActivityAt: '0' });
    const lifecycle = new SessionLifecycle(state, ctx);

    const pastDeadline = Date.now() - 60_000; // 1 minute ago
    lifecycle.scheduleAlarm([pastDeadline]);

    expect(alarms).toHaveLength(1);
    const scheduledTime = alarms[0];
    // Should be at least 29s in the future (allowing 1s for test execution)
    expect(scheduledTime).toBeGreaterThan(Date.now() + 29_000);
    expect(scheduledTime).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('does not clamp future deadlines', () => {
    const { ctx, alarms } = makeAlarmCtx();
    const state = new FakeSessionState({ idleTimeoutMs: '0', lastUserActivityAt: '0' });
    const lifecycle = new SessionLifecycle(state, ctx);

    const futureDeadline = Date.now() + 120_000; // 2 minutes from now
    lifecycle.scheduleAlarm([futureDeadline]);

    expect(alarms).toEqual([futureDeadline]);
  });
});
