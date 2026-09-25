import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const { createNamespaceProxy } = await import(process.argv[2]);
const mode = process.argv[3];
// Keep Unix socket paths below the macOS length limit.
const directory = await mkdtemp('/tmp/proxy-reset-');
const sockets = new Set();
const bodyBytes = 2 * 1024 * 1024;
let resetClient;
let first = true;
let pendingClosed;
const closed = new Promise(resolve => { pendingClosed = resolve; });
const broker = createServer(socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  socket.once('data', () => {
    if (first) {
      first = false;
      socket.once('close', pendingClosed);
      resetClient.resetAndDestroy();
      // No reply: client cancellation must close a still-pending handshake.
    } else {
      socket.write('OK\n');
      socket.once('data', () => socket.end(Buffer.alloc(bodyBytes, 7)));
    }
  });
});
await new Promise((resolve, reject) => {
  broker.once('error', reject);
  broker.listen(join(directory, 'broker.sock'), resolve);
});
const proxy = createNamespaceProxy(join(directory, 'broker.sock'));
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', resolve);
});
const port = proxy.address().port;
try {
  resetClient = createConnection(port, '127.0.0.1');
  resetClient.on('error', () => {});
  resetClient.once('connect', () => resetClient.write(mode === 'connect'
    ? 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'
    : 'GET http://example.com/socket HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
  await closed;
  assert.equal(sockets.size, 0, 'The cancelled broker socket must close.');

  const healthy = createConnection(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    healthy.once('error', reject);
    healthy.once('connect', () => healthy.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    healthy.once('data', chunk => {
      assert.match(chunk.toString(), /200 Connection Established/);
      let received = 0;
      healthy.on('data', body => { received += body.length; });
      healthy.once('end', () => {
        assert.equal(received, bodyBytes, 'Graceful upstream EOF must drain buffered bytes.');
        resolve();
      });
      healthy.write('send body');
      healthy.pause();
      setTimeout(() => healthy.resume(), 50);
    });
  });
  console.log('proxy survived; broker connections closed');
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise(resolve => proxy.close(resolve)),
    new Promise(resolve => broker.close(resolve)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
