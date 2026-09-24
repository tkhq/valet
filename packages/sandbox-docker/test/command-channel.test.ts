import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSandbox } from '../src/sandbox.js';

vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
function fixture() {
  const child = new ChildProcess();
  const stdin = new PassThrough({ highWaterMark: 4 });
  child.stdin = stdin;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(child);
  const sandbox = new DockerSandbox('test', { containerId: 'container', workspace: '/tmp/work', containerWorkspace: '/workspace', image: 'test', browser: true });
  return { child, sandbox, kill, stdin };
}

describe('Docker command channels', () => {
  it('opens one interactive exec, preserves workload identity, and streams without stdin EOF', async () => {
    const f = fixture(); const onData = vi.fn(); const onClose = vi.fn();
    expect(typeof f.sandbox.openCommandChannel).toBe('function');
    const opening = f.sandbox.openCommandChannel('client --stream', { onData, onClose });
    f.child.emit('spawn');
    const channel = await opening;
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toContain('--interactive'); expect(args).toContain('dockerd'); expect(args).toContain('--no-new-privs');
    const input: string[] = [];
    f.child.stdin?.on('data', (data: Buffer) => input.push(data.toString()));
    await channel?.write('one'); await channel?.write('two');
    f.child.stdout?.emit('data', 'reply');
    expect(input).toEqual(['one', 'two']); expect(onData).toHaveBeenCalledWith('reply');
    expect(f.child.stdin?.writableEnded).toBe(false);
    channel?.close(); channel?.close(); f.child.emit('close', 1);
    expect(onClose).toHaveBeenCalledTimes(1); expect(f.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps trusted commands privileged and rejects pending writes on abort', async () => {
    const f = fixture(); const abort = new AbortController(); const onClose = vi.fn();
    const opening = f.sandbox.openCommandChannel('client', { onData: vi.fn(), onClose, privileged: true, signal: abort.signal });
    f.child.emit('spawn'); const channel = await opening;
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain('dockerd');
    let flushed = false;
    const write = channel?.write('blocked').then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    abort.abort(new Error('cancelled'));
    await expect(write).rejects.toThrow('cancelled');
    expect(onClose).toHaveBeenCalledTimes(1); expect(f.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized write before sending it and reports process errors once', async () => {
    const f = fixture(); const onClose = vi.fn();
    const opening = f.sandbox.openCommandChannel('client', { onData: vi.fn(), onClose });
    f.child.emit('spawn'); const channel = await opening;
    await expect(channel?.write('x'.repeat(1_048_577))).rejects.toThrow(/limit|large/i);
    expect(f.child.stdin?.writableLength).toBe(0);
    f.child.emit('error', new Error('transport failed')); f.child.emit('close', 1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(channel?.write('later')).rejects.toThrow();
  });

  it('times out startup and performs no exec for a pre-aborted signal', async () => {
    vi.useFakeTimers(); const f = fixture(); const onClose = vi.fn();
    const opening = f.sandbox.openCommandChannel('client', { onData: vi.fn(), onClose });
    const rejected = expect(opening).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
    expect(f.kill).toHaveBeenCalledTimes(1);
    vi.mocked(spawn).mockClear();
    await expect(f.sandbox.openCommandChannel('client', { onData: vi.fn(), onClose, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds queued bytes and shares one drain listener under concurrent backpressure', async () => {
    const f = fixture();
    const opening = f.sandbox.openCommandChannel('client', { onData: vi.fn(), onClose: vi.fn() });
    f.child.emit('spawn'); const channel = await opening;
    const writes = Array.from({ length: 16 }, () => channel.write('x'.repeat(512 * 1024)));
    const results = Promise.allSettled(writes);
    await expect(channel.write('overflow')).rejects.toThrow(/limit/);
    expect(f.child.stdin?.listenerCount('drain')).toBeLessThanOrEqual(1);
    f.stdin.resume();
    expect((await results).every((result) => result.status === 'fulfilled')).toBe(true);
    await channel.write('next');
    channel.close();
  });
});
