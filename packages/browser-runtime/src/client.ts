#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRequest, BrowserFault } from './protocol.js';
import { requestDaemon } from './transport.js';
import { createDaemonClient } from './daemon-client.js';
import { clientError, runClientStream } from './client-stream.js';

const state = process.env.VALET_BROWSER_STATE ?? '/var/lib/valet/browser';
const request = createDaemonClient({
  request: (value, signal) => requestDaemon(value, join(state, 'browser.sock'), signal),
  wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
  start: async (signal) => {
    signal?.throwIfAborted();
    if (process.env.VALET_BROWSER_ENABLED !== '1')
      throw new BrowserFault('BROWSER_UNAVAILABLE', 'The sandbox browser is not installed or enabled.', 'Enable browser support and rebuild the sandbox image.');
    await mkdir(state, { recursive: true, mode: 0o700 });
    const log = await open(join(state, 'daemon.log'), 'a', 0o600);
    try {
      signal?.throwIfAborted();
      const child = spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url))], {
        detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
    } finally { await log.close(); }
  },
});

if (process.argv.includes('--stream')) {
  try { await runClientStream(process.stdin, process.stdout, request); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  try {
    process.stdin.setEncoding('utf8');
    let body = '';
    for await (const chunk of process.stdin) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 512_000)
        throw new BrowserFault('QUOTA_EXCEEDED', 'Browser request exceeds the size limit.', 'Submit a smaller cell.');
    }
    process.stdout.write(JSON.stringify(await request(parseRequest(JSON.parse(body)))) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify(clientError(error)) + '\n');
    process.exitCode = 1;
  }
}
