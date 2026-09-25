#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserDaemon } from './daemon.js';
import { confinedLaunch, EgressPolicy, serveEgress } from './confinement.js';
import { serveDaemon } from './transport.js';
process.umask(0o077);
const state = process.env.VALET_BROWSER_STATE ?? '/var/lib/valet/browser';
if (process.env.VALET_BROWSER_ENABLED !== '1' || !process.env.VALET_SESSION_ID)
  throw new Error(
    'The sandbox browser is disabled. Enable browser support and rebuild the sandbox.',
  );
await mkdir(state, { recursive: true, mode: 0o700 });
if (!process.argv.includes('--owned')) {
  const child = spawn(
    '/usr/bin/flock',
    [
      '--nonblock',
      join(state, 'owner.lock'),
      process.execPath,
      fileURLToPath(import.meta.url),
      '--owned',
    ],
    { stdio: 'inherit', env: process.env },
  );
  child.on('error', (error) => {
    process.stderr.write(error.message);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  // The kernel lock proves the previous owner exited. Stale sockets are a normal crash artifact.
  await rm(join(state, 'browser.sock'), { force: true });
  await rm(join(state, 'broker.sock'), { force: true });
  const launch = await confinedLaunch(state);
  const ports = (process.env.VALET_BROWSER_DEV_PORTS ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
  )
    throw new Error(
      'Browser development ports are invalid. Configure ports from 1024 through 65535.',
    );
  const policy = new EgressPolicy(ports);
  const broker = await serveEgress(join(state, 'broker.sock'), policy);
  const daemon = new BrowserDaemon({
    sessionId: process.env.VALET_SESSION_ID,
    stateDirectory: state,
    workingDirectory: process.env.VALET_WORKING_DIRECTORY ?? '/workspace',
    repl: launch.repl,
    browserLaunch: launch.browser,
    authorizeOrigin: (origin) => policy.allow(origin),
    revokeNetwork: () => policy.revoke(),
  });
  try {
    await daemon.start();
    const transport = await serveDaemon(
      daemon,
      join(state, 'browser.sock'),
      () => {
        void (async () => {
          await transport.close();
          await daemon.close();
          await broker.close();
          process.exit(0);
        })().catch(() => process.exit(1));
      },
    );
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        void (async () => {
          await transport.close();
          await daemon.close();
          await broker.close();
          process.exit(0);
        })().catch((error) => {
          process.stderr.write(String(error));
          process.exit(1);
        });
      });
  } catch (error) {
    await broker.close();
    throw error;
  }
}
