import { expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
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

it.each(['connect', 'upgrade'])('survives an early %s client reset and closes its pending broker connection', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-reset-'));
  try {
    const source = await readFile(new URL('../src/proxy.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const proxyPath = join(dir, 'proxy.mjs');
    await writeFile(proxyPath, compiled);
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/proxy-reset.mjs', import.meta.url)),
      pathToFileURL(proxyPath).href, mode,
    ], { timeout: 5000 });
    expect(result.stdout.trim()).toBe('proxy survived; broker connections closed');
    expect(result.stderr).toBe('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
