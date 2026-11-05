import { PassThrough } from 'node:stream';
import type { SandboxCommandChannel, SandboxCommandChannelOptions } from '@valet/engine';
import { exitCodeFromStatus, PodExecTransportError, wrapAsWorkloadUser, type ExecDeps, type PodExecSocket } from './exec.js';

const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 8 * MAX_WRITE_BYTES;
const MAX_PENDING_WRITES = 128;

interface PendingWrite {
  fail(error: Error): void;
  drain(): void;
  complete(): void;
}

/** Keep stdin open for the channel lifetime; EOF must not delimit individual requests. */
export function openCommandChannelInPod(
  deps: ExecDeps,
  podName: string,
  command: string,
  options: SandboxCommandChannelOptions,
): Promise<SandboxCommandChannel> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
  return new Promise((resolve, reject) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const startup = new AbortController();
    let socket: PodExecSocket | undefined;
    let opened = false;
    let closed = false;
    let failure: Error | undefined;
    let stderrText = '';
    let pendingBytes = 0;
    const pending = new Set<PendingWrite>();
    let bufferTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => finish(new Error('Command channel startup timed out. Check Kubernetes API access before reopening.')), 10_000);
    startupTimer.unref();

    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      failure = error;
      clearTimeout(startupTimer);
      clearTimeout(bufferTimer);
      options.signal?.removeEventListener('abort', onAbort);
      socket?.off?.('close', onSocketClose);
      // Keep the error listener until socket collection to absorb delayed transport errors.
      const cause = error ?? new Error('The command channel is closed. Open a new channel before writing.');
      startup.abort(cause);
      for (const write of [...pending]) write.fail(cause);
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      socket?.close();
      if (!opened) reject(cause);
      options.onClose(error);
    };
    const transportError = (cause: unknown) => new PodExecTransportError(deps.namespace, podName, deps.containerName, cause);
    const onAbort = () => finish(abortError(options.signal));
    const onSocketClose = () => finish(transportError(new Error('Command channel transport closed. Inspect the command outcome before continuing.')));
    const onSocketError = (error: unknown) => finish(transportError(error));
    const checkWrites = () => {
      if (closed) return;
      if (socket?.readyState !== undefined && socket.readyState !== 1) { onSocketClose(); return; }
      const buffered = socket?.bufferedAmount ?? 0;
      if (buffered > MAX_PENDING_BYTES) {
        finish(new Error('Command channel socket buffer limit exceeded. Open a new channel and send less data.'));
        return;
      }
      if (buffered === 0) {
        for (const write of [...pending]) write.complete();
      } else if (pending.size > 0 && bufferTimer === undefined) {
        // client-node forwards stdin to ws.send without propagating its backpressure.
        bufferTimer = setTimeout(() => { bufferTimer = undefined; checkWrites(); }, 5);
        bufferTimer.unref();
      }
    };
    stdin.on('drain', () => {
      for (const write of pending) write.drain();
      checkWrites();
    });
    for (const stream of [stdin, stdout, stderr]) stream.on('error', (error) => finish(error));
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (data: string) => {
      if (closed) return;
      try { options.onData(data); } catch (error) { finish(asError(error)); }
    });
    stderr.on('data', (data: string) => { stderrText = (stderrText + data).slice(-16_384); });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const shellCommand = deps.docker && !options.privileged ? wrapAsWorkloadUser(command, deps.browser) : command;
    const connect = async () => {
      try {
        const connected = await deps.api.exec(
          deps.namespace, podName, deps.containerName, ['/bin/sh', '-c', shellCommand], stdout, stderr, stdin, false,
          (status) => {
            try {
              const code = exitCodeFromStatus(status);
              finish(new Error(`Command channel exited (${code}). Open a new channel before continuing. ${stderrText.trim()}`));
            } catch (error) { finish(asError(error)); }
          },
          { signal: startup.signal, timeoutMs: 10_000 },
        );
        if (closed) { connected.close(); return; }
        socket = connected;
        if (!socket.on || !socket.off || socket.bufferedAmount === undefined || socket.readyState === undefined) {
          finish(new Error('The exec transport cannot support a command channel. Update the Kubernetes transport adapter.'));
          return;
        }
        socket.on('close', onSocketClose);
        socket.on('error', onSocketError);
        checkWrites();
        if (closed) return;
        opened = true;
        clearTimeout(startupTimer);
        resolve({
          close: () => finish(),
          write(data) {
            if (closed) return Promise.reject(failure ?? new Error('The command channel is closed. Open a new channel before writing.'));
            const bytes = Buffer.byteLength(data);
            if (bytes > MAX_WRITE_BYTES || pendingBytes + bytes > MAX_PENDING_BYTES || pending.size >= MAX_PENDING_WRITES) {
              return Promise.reject(new Error('Command channel write limit exceeded. Wait for pending writes or send less data.'));
            }
            pendingBytes += bytes;
            return new Promise<void>((resolveWrite, rejectWrite) => {
              let settled = false;
              let flushed = false;
              let drained = false;
              const settle = (error?: Error) => {
                if (settled) return;
                settled = true;
                pendingBytes -= bytes;
                pending.delete(write);
                if (error) rejectWrite(error); else resolveWrite();
              };
              const write: PendingWrite = {
                fail: (error) => settle(error),
                drain: () => { drained = true; },
                complete: () => { if (flushed && drained) settle(); },
              };
              pending.add(write);
              try {
                drained = stdin.write(data, (error) => {
                  if (error) { finish(error); return; }
                  flushed = true;
                  checkWrites();
                });
                checkWrites();
              } catch (error) { finish(asError(error)); }
            });
          },
        });
      } catch (error) { finish(transportError(error)); }
    };
    void connect();
    if (options.signal?.aborted) onAbort();
  });
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function abortError(signal?: AbortSignal): Error { return signal?.reason instanceof Error ? signal.reason : new Error('Command channel aborted. Open a new channel when needed.'); }
