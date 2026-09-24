import {
  BlockList,
  isIP,
  createServer,
  createConnection,
  type Socket,
} from 'node:net';
import { lookup } from 'node:dns/promises';
import { secureSocket } from './socket-mode.js';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { BrowserFault } from './protocol.js';
import type { ReplLaunchOptions } from './repl/process.js';
import type { BrowserBackendOptions } from './browser.js';
const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked6.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  return (
    family !== 0 &&
    !(family === 4 ? blocked : blocked6).check(
      address,
      family === 4 ? 'ipv4' : 'ipv6',
    )
  );
}
export class EgressPolicy {
  private approved = new Set<string>();
  private revoked = new Set<() => void>();
  onRevoke(callback: () => void) {
    this.revoked.add(callback);
    return () => this.revoked.delete(callback);
  }
  constructor(
    private readonly developmentPorts: number[] = [],
    private readonly resolve: (
      host: string,
    ) => Promise<{ address: string; family: number }[]> = (host) =>
      lookup(host, { all: true, verbatim: true }),
  ) {}
  allow(origin: string) {
    if (origin === 'about:blank') return;
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '::1'].includes(host) &&
        this.developmentPorts.includes(port)
      )
    )
      throw new BrowserFault(
        'ORIGIN_DENIED',
        'Browser egress permits public HTTPS and approved development ports.',
        'Use HTTPS or authorize this sandbox development port.',
      );
    this.approved.add(`${host}:${port}`);
  }
  revoke() {
    this.approved.clear();
    for (const callback of this.revoked) callback();
  }
  async destination(host: string, port: number) {
    host = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !this.approved.has(`${host}:${port}`)
    )
      throw new BrowserFault(
        'ORIGIN_DENIED',
        'The destination origin is not approved.',
        'Request browser origin access.',
      );
    if (
      ['localhost', '127.0.0.1', '::1'].includes(host) &&
      this.developmentPorts.includes(port)
    )
      return { address: '127.0.0.1', port };
    if (port !== 443)
      throw new BrowserFault(
        'ORIGIN_DENIED',
        'Public browser traffic must use HTTPS.',
        'Use an HTTPS destination on port 443.',
      );
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await this.resolve(host);
    if (!addresses.length || addresses.some((v) => !isPublicAddress(v.address)))
      throw new BrowserFault(
        'ORIGIN_DENIED',
        'The destination resolves to a restricted network.',
        'Use an approved public origin.',
      );
    return { address: addresses[0].address, port };
  }
}
/** The private broker connects to a validated literal IP, so DNS cannot rebind between validation and connect. */
export async function serveEgress(path: string, policy: EgressPolicy) {
  const sockets = new Set<Socket>();
  const unsubscribe = policy.onRevoke(() => {
    for (const socket of sockets) socket.destroy();
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(60_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      socket.pause();
      socket.off('data', handshake);
      void (async () => {
        const raw: unknown = JSON.parse(buffer.subarray(0, end).toString());
        if (!raw || typeof raw !== 'object')
          throw Error('Invalid proxy request');
        const host = Reflect.get(raw, 'host'),
          port = Reflect.get(raw, 'port');
        if (typeof host !== 'string' || typeof port !== 'number')
          throw Error('Invalid proxy target');
        const destination = await policy.destination(host, port);
        const upstream = createConnection({
          host: destination.address,
          port: destination.port,
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        upstream.on('connect', () => {
          socket.write('OK\n');
          const rest = buffer.subarray(end + 1);
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.resume();
        });
        socket.on('close', () => upstream.destroy());
      })().catch(() => socket.end('DENIED\n'));
    };
    socket.on('data', handshake);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await secureSocket(path, 0o600);
  return {
    close: async () => {
      unsubscribe();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
/** Classic BPF seccomp: disallow namespace creation, process forks, tracing, and kernel attack surfaces. */
export function replSeccomp(arch: string): Buffer {
  const table =
    arch === 'x64'
      ? {
          arch: 0xc000003e,
          clone: 56,
          clone3: 435,
          deny: [
            57, 58, 272, 308, 165, 166, 155, 101, 321, 250, 173, 298, 323, 310,
            311, 304,
          ],
        }
      : arch === 'arm64'
        ? {
            arch: 0xc00000b7,
            clone: 220,
            clone3: 435,
            deny: [97, 268, 40, 39, 41, 117, 280, 219, 241, 282, 270, 271, 265],
          }
        : undefined;
  if (!table)
    throw new BrowserFault(
      'BROWSER_UNAVAILABLE',
      'REPL confinement does not support this CPU architecture.',
      'Use amd64 or arm64.',
    );
  const instructions: [number, number, number, number][] = [];
  const add = (code: number, jt: number, jf: number, k: number) =>
    instructions.push([code, jt, jf, k]);
  add(0x20, 0, 0, 4);
  add(0x15, 1, 0, table.arch);
  add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0);
  if (arch === 'x64') {
    add(0x35, 0, 1, 0x40000000);
    add(0x06, 0, 0, 0x00050001);
  }
  for (const nr of table.deny) {
    add(0x15, 0, 1, nr);
    add(0x06, 0, 0, 0x00050001);
  }
  // clone3 returns ENOSYS so libc can use the inspected clone flags path.
  add(0x15, 0, 1, table.clone3);
  add(0x06, 0, 0, 0x00050026);
  add(0x15, 0, 4, table.clone);
  add(0x20, 0, 0, 16);
  add(0x45, 1, 0, 0x00010000);
  add(0x06, 0, 0, 0x00050001);
  add(0x06, 0, 0, 0x7fff0000);
  add(0x06, 0, 0, 0x7fff0000);
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    buffer.writeUInt16LE(code, index * 8);
    buffer.writeUInt8(jt, index * 8 + 2);
    buffer.writeUInt8(jf, index * 8 + 3);
    buffer.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return buffer;
}
export async function confinedLaunch(stateDirectory: string): Promise<{
  repl: ReplLaunchOptions;
  browser: BrowserBackendOptions['launch'];
}> {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    process.env.VALET_BROWSER_CONFINE !== '1'
  )
    throw new BrowserFault(
      'BROWSER_UNAVAILABLE',
      'Verified non-root Linux browser confinement is unavailable.',
      'Rebuild the sandbox with the browser security profile enabled.',
    );
  await access('/usr/bin/bwrap', constants.X_OK);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const seccompPath = join(stateDirectory, 'repl-seccomp.bpf');
  await writeFile(seccompPath, replSeccomp(process.arch), { mode: 0o600 });
  const replArgs = [
    '--unshare-all',
    '--unshare-user',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    root,
    root,
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin',
    '--setenv',
    'NODE_CHANNEL_FD',
    '3',
    '--setenv',
    'NODE_CHANNEL_SERIALIZATION_MODE',
    'json',
    '--chdir',
    '/tmp',
    '--seccomp',
    '4',
  ];
  if (process.arch === 'x64')
    replArgs.unshift('--symlink', 'usr/lib64', '/lib64');
  const wrapper = join(stateDirectory, 'chromium-launch');
  const script = `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(join(root, 'dist', 'chromium-wrapper.js'))} "$@"\n`;
  await writeFile(wrapper, script, { mode: 0o700 });
  return {
    repl: {
      launcher: {
        executable: '/usr/bin/prlimit',
        // RLIMIT_NPROC counts Chromium and other containers sharing this UID.
        // The child seccomp filter prevents process forks; memory bounds threads.
        args: [
          '--cpu=120',
          '--data=268435456',
          '--nofile=128',
          '--',
          '/usr/bin/bwrap',
          ...replArgs,
        ],
        seccompPath,
      },
    },
    browser: {
      executablePath: wrapper,
      confinement: 'bubblewrap',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: stateDirectory,
        VALET_BROWSER_STATE: stateDirectory,
        VALET_CHROMIUM_EXECUTABLE: chromium.executablePath(),
        VALET_BROWSER_ROOT: root,
      },
      args: [
        '--proxy-server=http://127.0.0.1:8877',
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    },
  };
}
function shell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
