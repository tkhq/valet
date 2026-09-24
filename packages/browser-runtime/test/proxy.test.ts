import { expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EgressPolicy, serveEgress } from '../src/confinement.js';
import { createNamespaceProxy } from '../src/proxy.js';
const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(Error('No port'));
      else resolve(address.port);
    });
  });
it('routes HTTP bodies through the approved Unix broker rather than a new direct socket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-proxy-'));
  const fixture = createServer((req, res) => {
    res.end('broker reached fixture');
  });
  const port = await listen(fixture);
  class FixturePolicy extends EgressPolicy {
    override async destination() {
      return { address: '127.0.0.1', port };
    }
  }
  const broker = await serveEgress(
    join(dir, 'broker.sock'),
    new FixturePolicy(),
  );
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: 'http://unresolvable.invalid:5173/',
          method: 'GET',
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += String(chunk)));
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(response).toBe('broker reached fixture');
  } finally {
    proxy.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
