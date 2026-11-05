import type { Readable, Writable } from 'node:stream';
import type { BrowserRequest, BrowserResponse } from '@valet/shared';
import { BrowserFault, fault, object, parseRequest, string } from './protocol.js';

const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ACTIVE = 16;
const IDLE_MS = 45_000;

export function clientError(error: unknown): BrowserResponse {
  return {
    protocolVersion: '1.0', runtimeId: 'unavailable', ok: false,
    events: [], cursor: 0, gap: false, error: fault(error),
  };
}

/** A private exec stream carries independent requests with bounded buffers. */
export function runClientStream(
  input: Readable,
  output: Writable,
  request: (request: BrowserRequest, signal: AbortSignal) => Promise<BrowserResponse>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const active = new Set<string>();
    let partial = '';
    let closed = false;
    let outputBytes = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;

    function finish(error?: Error) {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      controller.abort();
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onClose);
      input.off('error', onError);
      output.off('error', onError);
      input.pause();
      if (error) reject(error);
      else resolve();
    }
    function onError(error: Error) { finish(error); }
    function onClose() { finish(); }
    function onEnd() {
      if (partial.length) finish(new BrowserFault('INVALID_REQUEST', 'The browser stream ended inside a request.', 'Send a complete JSON line.'));
      else finish();
    }
    function armIdle() {
      clearTimeout(idle);
      if (!closed && active.size === 0) idle = setTimeout(() => finish(), IDLE_MS);
    }
    function send(id: string, response: BrowserResponse): Promise<void> {
      if (closed) return Promise.resolve();
      let line = JSON.stringify({ id, response }) + '\n';
      if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        line = JSON.stringify({ id, response: clientError(new BrowserFault(
          'QUOTA_EXCEEDED', 'The browser response exceeds the transport size limit.',
          'Read smaller event batches or use a smaller browser viewport.',
        )) }) + '\n';
      }
      const bytes = Buffer.byteLength(line);
      if (outputBytes + bytes > MAX_RESPONSE_BYTES * MAX_ACTIVE) {
        const error = new BrowserFault('QUOTA_EXCEEDED', 'The browser output queue is full.', 'Read pending replies before sending more requests.');
        finish(error);
        return Promise.resolve();
      }
      outputBytes += bytes;
      return new Promise<void>((done) => {
        output.write(line, () => {
          outputBytes -= bytes;
          done();
        });
      });
    }
    function dispatch(line: string) {
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES)
        throw new BrowserFault('QUOTA_EXCEEDED', 'The browser request exceeds the size limit.', 'Send a smaller JSON request.');
      const envelope = object(JSON.parse(line));
      const id = string(envelope.id, 'request ID', 128);
      if (active.has(id))
        throw new BrowserFault('INVALID_REQUEST', 'The browser stream contains a duplicate active request ID.', 'Use a unique ID for each pending request.');
      if (active.size >= MAX_ACTIVE) {
        void send(id, clientError(new BrowserFault('QUOTA_EXCEEDED', 'The browser stream has sixteen active requests.', 'Wait for a pending reply before sending another request.')));
        return;
      }
      let parsed: BrowserRequest;
      try { parsed = parseRequest(envelope.request); }
      catch (error) { void send(id, clientError(error)); return; }
      active.add(id);
      clearTimeout(idle);
      void Promise.resolve()
        .then(() => closed ? undefined : request(parsed, controller.signal))
        .then((response) => response ? send(id, response) : undefined, (error) => send(id, clientError(error)))
        .finally(() => {
          active.delete(id);
          armIdle();
        });
    }
    function onData(chunk: string) {
      if (closed) return;
      try {
        partial += chunk;
        let newline: number;
        while (!closed && (newline = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, newline);
          partial = partial.slice(newline + 1);
          dispatch(line);
        }
        if (Buffer.byteLength(partial) > MAX_REQUEST_BYTES)
          throw new BrowserFault('QUOTA_EXCEEDED', 'The browser request exceeds the size limit.', 'Send a smaller JSON request.');
        armIdle();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onClose);
    input.on('error', onError);
    output.on('error', onError);
    armIdle();
  });
}
