#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRequest, fault, BrowserFault } from './protocol.js';
import { requestDaemon } from './transport.js';
async function main() {
  process.stdin.setEncoding('utf8');
  let body = '';
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 512_000)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Browser request exceeds the size limit.',
        'Submit a smaller cell.',
      );
  }
  const request = parseRequest(JSON.parse(body));
  const state = process.env.VALET_BROWSER_STATE ?? '/var/lib/valet/browser';
  const socket = join(state, 'browser.sock');
  try {
    return await requestDaemon(request, socket);
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? Reflect.get(error, 'code')
        : undefined;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
  }
  if (process.env.VALET_BROWSER_ENABLED !== '1')
    throw new BrowserFault(
      'BROWSER_UNAVAILABLE',
      'The sandbox browser is not installed or enabled.',
      'Enable browser support and rebuild the sandbox image.',
    );
  await mkdir(state, { recursive: true, mode: 0o700 });
  const log = await open(join(state, 'daemon.log'), 'a', 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./main.js', import.meta.url))],
    { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env },
  );
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(200);
    try {
      return await requestDaemon(request, socket);
    } catch (error) {
      const code =
        error && typeof error === 'object'
          ? Reflect.get(error, 'code')
          : undefined;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
    }
  }
  throw new BrowserFault(
    'BROWSER_UNAVAILABLE',
    'The browser daemon did not start.',
    'Inspect the private daemon log and rebuild an incompatible sandbox image.',
  );
}
try {
  process.stdout.write(JSON.stringify(await main()) + '\n');
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      protocolVersion: '1.0',
      runtimeId: 'unavailable',
      ok: false,
      events: [],
      cursor: 0,
      gap: false,
      error: fault(error),
    }) + '\n',
  );
  process.exitCode = 1;
}
