import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCommandChannelInPod } from '../src/command-channel.js';
import type { ExecDeps, ExecStatus, PodExecApi, PodExecSocket } from '../src/exec.js';

afterEach(() => vi.useRealTimers());
class Socket extends EventEmitter { bufferedAmount = 0; readyState = 1; close = vi.fn(() => { this.readyState = 3; this.emit('close'); }); }
function fixture() {
  const socket = new Socket();
  let input: Readable | null = null;
  let output: Writable | null = null;
  let status: ((value: ExecStatus) => void) | undefined;
  const exec: PodExecApi['exec'] = vi.fn(async (_ns, _pod, _container, _command, stdout, _stderr, stdin, _tty, callback) => { input = stdin; output = stdout; status = callback; return socket; });
  const deps: ExecDeps = { api: { exec }, namespace: 'test', containerName: 'sandbox', docker: true, browser: true };
  return { deps, socket, input: () => input, output: () => output, status: (value: ExecStatus) => status?.(value) };
}

describe('Kubernetes command channels', () => {
  it('keeps stdin open and preserves identity without single-request EOF framing', async () => {
    const f = fixture(); const onData = vi.fn(); const onClose = vi.fn();
    const channel = await openCommandChannelInPod(f.deps, 'pod', 'client --stream', { onData, onClose });
    const invocation = vi.mocked(f.deps.api.exec).mock.calls[0];
    expect(invocation?.[3].join(' ')).toContain('--reuid dockerd');
    expect(invocation?.[3].join(' ')).not.toContain('head -c');
    const chunks: string[] = []; f.input()?.on('data', (data: Buffer) => chunks.push(data.toString()));
    await channel.write('first'); await channel.write('second'); f.output()?.write('reply');
    expect(chunks).toEqual(['first', 'second']); expect(onData).toHaveBeenCalledWith('reply');
    expect(f.input()?.readable).toBe(true);
    channel.close(); channel.close(); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('waits for WebSocket backpressure and rejects on a transport close', async () => {
    vi.useFakeTimers(); const f = fixture(); const onClose = vi.fn();
    const channel = await openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose, privileged: true });
    expect(vi.mocked(f.deps.api.exec).mock.calls[0]?.[3].join(' ')).not.toContain('setpriv');
    f.input()?.resume(); f.socket.bufferedAmount = 100;
    let completed = false; const writing = channel.write('request').then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(10); expect(completed).toBe(false);
    f.socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(10); await writing;
    f.socket.emit('close');
    expect(onClose).toHaveBeenCalledWith(expect.any(Error));
    await expect(channel.write('later')).rejects.toThrow();
  });

  it('rejects pending writes on status and signals close once', async () => {
    const f = fixture(); const onClose = vi.fn();
    const channel = await openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose });
    const writing = channel.write('x'.repeat(100_000));
    f.status({ status: 'Failure', message: 'command failed' });
    await expect(writing).rejects.toThrow();
    f.socket.emit('close'); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending upgrade and closes the socket if it arrives later', async () => {
    const f = fixture(); const signal = new AbortController();
    let connect: ((socket: Socket) => void) | undefined;
    f.deps.api.exec = () => new Promise((resolve) => { connect = resolve; });
    const opening = openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose: vi.fn(), signal: signal.signal });
    signal.abort(new Error('cancelled'));
    await expect(opening).rejects.toThrow('cancelled');
    connect?.(f.socket); await Promise.resolve(); await Promise.resolve();
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });

  it('bounds startup, rejects pre-aborted opens, and bounds writes', async () => {
    vi.useFakeTimers(); const f = fixture();
    const realExec = f.deps.api.exec;
    f.deps.api.exec = vi.fn(() => new Promise<PodExecSocket>(() => {}));
    const opening = openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose: vi.fn() });
    const failed = expect(opening).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_001); await failed;
    f.deps.api.exec = realExec;
    await expect(openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose: vi.fn(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect(realExec).not.toHaveBeenCalled();
    const channel = await openCommandChannelInPod(f.deps, 'pod', 'client', { onData: vi.fn(), onClose: vi.fn() });
    await expect(channel.write('x'.repeat(1_048_577))).rejects.toThrow(/limit|large/i);
    channel.close();
  });

  it('bounds concurrent queued data and tolerates late errors after closure', async () => {
    const f = fixture(); const onData = vi.fn(); const onClose = vi.fn();
    const channel = await openCommandChannelInPod(f.deps, 'pod', 'client', { onData, onClose });
    f.input()?.resume();
    f.socket.bufferedAmount = 1;
    const writes = Array.from({ length: 16 }, () => channel.write('x'.repeat(512 * 1024)));
    const results = Promise.allSettled(writes);
    await expect(channel.write('overflow')).rejects.toThrow(/limit/);
    f.socket.emit('error', new Error('lost connection'));
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(() => f.socket.emit('error', new Error('late error'))).not.toThrow();
    f.output()?.write('late output');
    expect(onData).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
});
