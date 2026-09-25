import { expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { createConnection, Socket } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EgressPolicy, serveEgress } from '../src/confinement.js';
import { createNamespaceProxy } from '../src/proxy.js';
const ipv6LoopbackAvailable = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '::1', () => server.close(() => resolve(true)));
});

const listen = (server: Server, host = '127.0.0.1') =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
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

const requestThroughProxy = (proxyPort: number, target: string) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: proxyPort, path: target },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });

it.skipIf(!ipv6LoopbackAvailable)('reaches a development server that listens only on IPv6 loopback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-proxy-ipv6-'));
  const fixture = createServer((_req, res) => res.end('ipv6 fixture reached'));
  const port = await listen(fixture, '::1');
  const policy = new EgressPolicy([port]);
  policy.allow(`http://localhost:${port}`);
  const broker = await serveEgress(join(dir, 'broker.sock'), policy);
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    await expect(
      requestThroughProxy(proxyPort, `http://localhost:${port}/`),
    ).resolves.toEqual({ statusCode: 200, body: 'ipv6 fixture reached' });
  } finally {
    proxy.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['localhost', '127.0.0.1', '[::1]'])(
  'returns 502 when an approved development server is unavailable at %s',
  async (host) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-proxy-unavailable-'));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const policy = new EgressPolicy([port]);
  policy.allow(`http://${host}:${port}`);
  const broker = await serveEgress(join(dir, 'broker.sock'), policy);
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    await expect(
      requestThroughProxy(proxyPort, `http://${host}:${port}/`),
    ).resolves.toEqual({
      statusCode: 502,
      body: `Nothing is listening on ${host}:${port} (tried 127.0.0.1 and ::1).`,
    });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
  },
);

it('returns 403 when the origin is not approved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-proxy-denied-'));
  const broker = await serveEgress(
    join(dir, 'broker.sock'),
    new EgressPolicy([5173]),
  );
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    await expect(
      requestThroughProxy(proxyPort, 'http://localhost:5173/'),
    ).resolves.toEqual({ statusCode: 403, body: 'Browser origin denied.' });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['revoke', 'close'])(
  'destroys a pending upstream connection on broker %s',
  async (action) => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-egress-pending-'));
    const policy = new EgressPolicy([5173]);
    policy.allow('http://localhost:5173');
    const candidates: Socket[] = [];
    const broker = await serveEgress(
      join(dir, 'broker.sock'),
      policy,
      () => {
        const candidate = new Socket();
        candidates.push(candidate);
        setTimeout(() => candidate.emit('connect'), 100);
        return candidate;
      },
    );
    const client = createConnection({ path: join(dir, 'broker.sock') });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      client.write(JSON.stringify({ host: 'localhost', port: 5173 }) + '\n');
      await expect.poll(() => candidates.length).toBe(1);
      if (action === 'revoke') policy.revoke();
      else client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(candidates).toHaveLength(1);
      expect(candidates[0].destroyed).toBe(true);
    } finally {
      client.destroy();
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('keeps an established tunnel open beyond the connect timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-egress-slow-response-'));
  const fixture = createServer((_req, res) => {
    setTimeout(() => res.end('slow fixture reached'), 500);
  });
  const port = await listen(fixture);
  const policy = new EgressPolicy([port]);
  policy.allow(`http://localhost:${port}`);
  const broker = await serveEgress(
    join(dir, 'broker.sock'),
    policy,
    createConnection,
    200,
  );
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    await expect(
      requestThroughProxy(proxyPort, `http://localhost:${port}/`),
    ).resolves.toEqual({ statusCode: 200, body: 'slow fixture reached' });
  } finally {
    proxy.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds a candidate connection that never completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-egress-connect-timeout-'));
  const policy = new EgressPolicy([5173]);
  policy.allow('http://localhost:5173');
  const candidates: Socket[] = [];
  const broker = await serveEgress(
    join(dir, 'broker.sock'),
    policy,
    () => {
      const candidate = new Socket();
      candidates.push(candidate);
      return candidate;
    },
    50,
  );
  const proxy = createNamespaceProxy(join(dir, 'broker.sock'));
  const proxyPort = await listen(proxy);
  try {
    await expect(
      requestThroughProxy(proxyPort, 'http://localhost:5173/'),
    ).resolves.toEqual({
      statusCode: 502,
      body: 'Nothing is listening on localhost:5173 (tried 127.0.0.1 and ::1).',
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.destroyed)).toBe(true);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
