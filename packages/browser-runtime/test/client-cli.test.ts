import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

it('answers stream requests before stdin closes and correlates their IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-stream-cli-'));
  const sockets = new Set<Socket>();
  const response = { protocolVersion: '1.0', runtimeId: 'r', ok: true, events: [], cursor: 0, gap: false };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end(JSON.stringify(response) + '\n'));
  });
  server.listen(join(dir, 'browser.sock'));
  await once(server, 'listening');
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/client.ts', import.meta.url).pathname, '--stream'], {
    env: { ...process.env, VALET_BROWSER_STATE: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  try {
    child.stdin.write(JSON.stringify({ id: 'request-1', request: { protocolVersion: '1.0', sessionId: 's', threadId: 't', actorId: 'a', ownerId: 'a', command: 'status' } }) + '\n');
    const deadline = Date.now() + 1500;
    while (!output.includes('\n') && Date.now() < deadline) await delay(10);
    expect(output, 'A response must arrive while stdin remains open').not.toBe('');
    expect(JSON.parse(output)).toEqual({ id: 'request-1', response });
  } finally {
    child.kill('SIGKILL');
    await once(child, 'close');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
