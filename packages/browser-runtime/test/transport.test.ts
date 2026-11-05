import { expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { requestDaemon } from '../src/transport.js';
const request = { protocolVersion: '1.0' as const, sessionId: 's', threadId: 't', actorId: 'a', ownerId: 'a', command: 'status' as const };

it('closes the Unix request socket when its stream aborts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-transport-'));
  let accepted!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => { accepted = resolve; });
  const server = createServer(accepted);
  const path = join(dir, 'browser.sock');
  server.listen(path); await once(server, 'listening');
  const controller = new AbortController();
  const result = requestDaemon(request, path, controller.signal);
  const peer = await connected;
  peer.resume();
  try {
    const rejected = expect(Promise.race([result, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('abort did not settle')), 100))])).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    await once(peer, 'close');
  } finally {
    peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await result.catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
