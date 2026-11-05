import { spawn } from 'node:child_process';
import type { SandboxCommandChannel, SandboxCommandChannelOptions } from '@valet/engine';

const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 8 * MAX_WRITE_BYTES;
const MAX_PENDING_WRITES = 128;

/** Own one Docker exec process and its open stdin until explicit close or failure. */
export function openDockerCommandChannel(args: string[], options: SandboxCommandChannelOptions): Promise<SandboxCommandChannel> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let opened = false; let closed = false;
    let failure: Error | undefined;
    let pendingBytes = 0;
    let stderr = '';
    const pending = new Set<(error: Error) => void>();
    const drainWaiters = new Set<() => void>();
    const timer = setTimeout(() => finish(new Error('Command channel startup timed out. Check Docker connectivity before reopening.')), 10_000);
    timer.unref();
    const finish = (error?: Error, kill = true) => {
      if (closed) return;
      closed = true; failure = error;
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      child.stdout.off('data', onData); child.stderr.off('data', onStderr);
      const cause = error ?? new Error('The command channel is closed. Open a new channel before writing.');
      for (const fail of [...pending]) fail(cause);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (kill) child.kill('SIGKILL');
      if (!opened) reject(cause);
      options.onClose(error);
    };
    const onAbort = () => finish(abortError(options.signal));
    const onData = (data: string) => {
      if (closed) return;
      try { options.onData(data); } catch (error) { finish(asError(error)); }
    };
    const onStderr = (data: string) => { stderr = (stderr + data).slice(-16_384); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData); child.stderr.on('data', onStderr);
    child.stdin.on('drain', () => { for (const onDrain of [...drainWaiters]) onDrain(); });
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('error', (error) => finish(error));
    child.stderr.on('error', (error) => finish(error));
    child.on('close', (code, signal) => finish(new Error(`Command channel exited (${code ?? signal ?? 'unknown'}). Open a new channel before continuing. ${stderr.trim()}`), false));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('spawn', () => {
      if (closed) return;
      opened = true; clearTimeout(timer);
      resolve({
        close: () => finish(),
        write(data) {
          if (closed) return Promise.reject(failure ?? new Error('The command channel is closed. Open a new channel before writing.'));
          const bytes = Buffer.byteLength(data);
          if (bytes > MAX_WRITE_BYTES || pendingBytes + bytes > MAX_PENDING_BYTES || pending.size >= MAX_PENDING_WRITES) return Promise.reject(new Error('Command channel write limit exceeded. Wait for pending writes or send less data.'));
          pendingBytes += bytes;
          return new Promise<void>((resolveWrite, rejectWrite) => {
            let settled = false;
            let flushed = false;
            let drained = false;
            const settle = (error?: Error) => {
              if (settled) return;
              settled = true; pendingBytes -= bytes; pending.delete(fail);
              drainWaiters.delete(onDrain);
              if (error) rejectWrite(error); else resolveWrite();
            };
            const fail = (error: Error) => settle(error);
            const complete = () => { if (flushed && drained) settle(); };
            const onDrain = () => { drained = true; complete(); };
            pending.add(fail); drainWaiters.add(onDrain);
            try {
              drained = child.stdin.write(data, (error) => {
                if (error) { finish(error); return; }
                flushed = true; complete();
              });
              complete();
            } catch (error) { finish(asError(error)); }
          });
        },
      });
    });
    if (options.signal?.aborted) onAbort();
  });
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function abortError(signal?: AbortSignal): Error { return signal?.reason instanceof Error ? signal.reason : new Error('Command channel aborted. Open a new channel when needed.'); }
