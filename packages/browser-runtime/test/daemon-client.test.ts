import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserRequest, BrowserResponse } from '@valet/shared';
import { createDaemonClient } from '../src/daemon-client.js';
const request: BrowserRequest = { protocolVersion: '1.0', sessionId: 's', threadId: 't', actorId: 'a', ownerId: 'a', command: 'status' };
const response: BrowserResponse = { protocolVersion: '1.0', runtimeId: 'r', ok: true, events: [], cursor: 0, gap: false };
afterEach(() => vi.useRealTimers());

it('starts the daemon once for concurrent first requests and dispatches each after readiness', async () => {
  let launched = 0;
  let ready = false;
  let dispatched = 0;
  const client = createDaemonClient({
    start: async () => { launched++; },
    wait: async () => { ready = true; },
    request: async () => {
      if (!ready) throw Object.assign(new Error('not listening'), { code: 'ENOENT' });
      dispatched++; return response;
    },
  });
  expect(await Promise.all([client(request), client(request), client(request)])).toEqual([response, response, response]);
  expect(launched).toBe(1);
  expect(dispatched).toBe(4); // One readiness status plus three original requests.
});

it('does not restart or replay a request after a possible mutation', async () => {
  let calls = 0;
  let starts = 0;
  const client = createDaemonClient({
    start: async () => { starts++; },
    wait: async () => {},
    request: async () => { calls++; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); },
  });
  await expect(client(request)).rejects.toThrow('connection reset');
  expect(calls).toBe(1); expect(starts).toBe(0);
});

it('propagates startup failure and permits a later independent start', async () => {
  let starts = 0;
  const client = createDaemonClient({
    start: async () => { starts++; throw new Error('start failed'); },
    wait: async () => {},
    request: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  await expect(Promise.all([client(request), client(request)])).rejects.toThrow('start failed');
  await expect(client(request)).rejects.toThrow('start failed');
  expect(starts).toBe(2);
});

it('passes cancellation through startup waits without dispatching the original request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = createDaemonClient({
    start: async () => {},
    wait: async (_ms, signal) => { controller.abort(); signal?.throwIfAborted(); },
    request: async () => { attempts++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  await expect(client(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(attempts).toBe(1);
});
