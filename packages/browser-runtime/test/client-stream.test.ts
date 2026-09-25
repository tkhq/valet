import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import type { BrowserRequest, BrowserResponse } from '@valet/shared';
import { runClientStream } from '../src/client-stream.js';

const request: BrowserRequest = { protocolVersion: '1.0', sessionId: 's', threadId: 't', actorId: 'a', ownerId: 'a', command: 'status' };
const response: BrowserResponse = { protocolVersion: '1.0', runtimeId: 'r', ok: true, events: [], cursor: 0, gap: false };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(handle: (value: BrowserRequest, signal: AbortSignal) => Promise<BrowserResponse>) {
  const input = new PassThrough();
  let output = '';
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += chunk.toString(); callback(); } });
  const completed = runClientStream(input, sink, handle);
  cleanups.push(() => input.destroy());
  const send = (id: string) => input.write(JSON.stringify({ id, request }) + '\n');
  const replies = () => output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { input, completed, send, replies, sink };
}

it('lets input replies overtake a pending poll and preserves each ID', async () => {
  const poll = deferred<BrowserResponse>();
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? poll.promise : response);
  f.send('poll'); f.send('input'); await tick();
  expect(f.replies()).toEqual([{ id: 'input', response }]);
  poll.resolve(response); await tick();
  expect(f.replies()).toEqual([{ id: 'input', response }, { id: 'poll', response }]);
  f.input.end(); await f.completed;
});

it('caps active dispatch at sixteen without queuing excess operations', async () => {
  const pending = deferred<BrowserResponse>();
  let calls = 0;
  const f = fixture(async () => { calls++; return pending.promise; });
  for (let index = 0; index < 17; index++) f.send(String(index));
  await tick();
  expect(calls).toBe(16);
  expect(f.replies()[0]).toMatchObject({ id: '16', response: { ok: false, error: { code: 'QUOTA_EXCEEDED' } } });
  pending.resolve(response); await tick();
  f.input.end(); await f.completed;
});

it('parses split UTF-8 lines and multiple complete lines in one chunk', async () => {
  const f = fixture(async (value) => ({ ...response, description: value.actorId }));
  const line = Buffer.from(JSON.stringify({ id: 'a', request: { ...request, actorId: '俐' } }) + '\n');
  const split = line.indexOf(Buffer.from('俐')) + 1;
  f.input.write(line.subarray(0, split));
  f.input.write(Buffer.concat([line.subarray(split), Buffer.from(JSON.stringify({ id: 'b', request }) + '\n')]));
  await tick();
  expect(f.replies().map((reply) => [reply.id, reply.response.description])).toEqual([['a', '俐'], ['b', 'a']]);
  f.input.end(); await f.completed;
});

it('rejects oversized and duplicate active envelopes before dispatch', async () => {
  const pending = deferred<BrowserResponse>();
  const f = fixture(async () => pending.promise);
  const rejected = expect(f.completed).rejects.toThrow(/duplicate/i);
  f.send('duplicate'); f.send('duplicate');
  await rejected;
  const g = fixture(async () => response);
  const oversized = expect(g.completed).rejects.toThrow(/size limit/i);
  g.input.write('x'.repeat(512001));
  await oversized;
});

it('returns correlated invalid-request and oversized-response errors', async () => {
  const f = fixture(async () => ({ ...response, description: 'x'.repeat(1000000) }));
  f.input.write(JSON.stringify({ id: 'invalid', request: { ...request, command: 'shell' } }) + '\n');
  f.send('large'); await tick();
  expect(f.replies()).toMatchObject([
    { id: 'invalid', response: { ok: false, error: { code: 'INVALID_REQUEST' } } },
    { id: 'large', response: { ok: false, error: { code: 'QUOTA_EXCEEDED' } } },
  ]);
  expect(f.replies().every((reply) => Buffer.byteLength(JSON.stringify(reply)) <= 1000000)).toBe(true);
  f.input.end(); await f.completed;
});

it('aborts remote requests on stdin close and never writes a late result', async () => {
  const pending = deferred<BrowserResponse>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_request, value) => { signal = value; return pending.promise; });
  f.send('pending'); await tick();
  f.input.end(); await f.completed;
  expect(signal?.aborted).toBe(true);
  pending.resolve(response); await tick();
  expect(f.replies()).toEqual([]);
});

it('expires after forty-five idle seconds and keeps active requests alive', async () => {
  vi.useFakeTimers();
  const pending = deferred<BrowserResponse>();
  const f = fixture(async () => pending.promise);
  let ended = false;
  void f.completed.then(() => { ended = true; });
  f.send('long'); await vi.advanceTimersByTimeAsync(46000);
  expect(ended).toBe(false);
  pending.resolve(response); await tick();
  await vi.advanceTimersByTimeAsync(44999); expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await f.completed;
  expect(ended).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes on stdout failure and cancels active requests', async () => {
  const pending = deferred<BrowserResponse>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_request, value) => { signal = value; return pending.promise; });
  const rejected = expect(f.completed).rejects.toThrow('broken output');
  f.send('pending'); await tick();
  f.sink.destroy(new Error('broken output'));
  await rejected;
  expect(signal?.aborted).toBe(true);
});
