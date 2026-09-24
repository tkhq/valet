import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Exec, KubeConfig } from '@kubernetes/client-node';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { openCommandChannelInPod } from '../src/command-channel.js';
import { podExecApiAdapter } from '../src/exec.js';

afterEach(() => vi.useRealTimers());

function localConfig(port: number) {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'test', server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test',
  });
  return config;
}

it.each(['abort', 'timeout'] as const)('disposes an unfinished WebSocket upgrade on %s', async (action) => {
  const server = createServer();
  const peers = new Set<Duplex>();
  let accepted!: (peer: Duplex) => void;
  const upgraded = new Promise<Duplex>((resolve) => { accepted = resolve; });
  server.on('upgrade', (_request, peer) => {
    peers.add(peer);
    peer.resume();
    accepted(peer);
    // Deliberately leave the HTTP upgrade unanswered.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  const config = localConfig(address.port);
  const controller = new AbortController();
  if (action === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const opening = openCommandChannelInPod({ api: podExecApiAdapter(new Exec(config)), namespace: 'test', containerName: 'sandbox' }, 'pod', 'client', {
    onData: vi.fn(), onClose: vi.fn(), signal: controller.signal,
  });
  const rejected = expect(opening).rejects.toThrow(action === 'abort' ? /cancelled/ : /timed out/);
  try {
    const peer = await Promise.race([upgraded, opening.then(() => { throw new Error('Expected a stalled upgrade.'); })]);
    if (action === 'abort') controller.abort(new Error('cancelled'));
    else await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    vi.useRealTimers();
    for (let attempt = 0; attempt < 20 && !peer.readableEnded; attempt++) await delay(5);
    expect(peer.readableEnded, 'The client must dispose the actual TCP upgrade connection.').toBe(true);
  } finally {
    controller.abort();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('streams through the real client-node adapter and closes after remote status', async () => {
  const server = createServer();
  const wsServer = new WebSocketServer({ server });
  const peers = new Set<WebSocket>();
  let accepted!: (peer: WebSocket) => void;
  const connected = new Promise<WebSocket>((resolve) => { accepted = resolve; });
  wsServer.on('connection', (peer) => { peers.add(peer); accepted(peer); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  const controller = new AbortController();
  const onData = vi.fn(); const onClose = vi.fn();
  try {
    const channel = await openCommandChannelInPod({ api: podExecApiAdapter(new Exec(localConfig(address.port))), namespace: 'test', containerName: 'sandbox' }, 'pod', 'client', {
      onData, onClose, signal: controller.signal,
    });
    const peer = await connected;
    const first = once(peer, 'message');
    await channel.write('first\n');
    expect((await first)[0]).toEqual(Buffer.concat([Buffer.from([0]), Buffer.from('first\n')]));
    const second = once(peer, 'message');
    await channel.write('second\n');
    expect((await second)[0]).toEqual(Buffer.concat([Buffer.from([0]), Buffer.from('second\n')]));
    peer.send(Buffer.concat([Buffer.from([1]), Buffer.from('reply\n')]));
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith('reply\n'));
    peer.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Success' }))]));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await expect(channel.write('late')).rejects.toThrow(/exited/);
    channel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
