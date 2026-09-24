import { createConnection, createServer } from 'node:net';
import { secureSocket } from './socket-mode.js';
import { rm } from 'node:fs/promises';
import type { BrowserRequest, BrowserResponse } from '@valet/shared';
import { BrowserDaemon } from './daemon.js';
import { BrowserFault, fault } from './protocol.js';
/** One request per Unix connection. Neither model source nor URLs enter shell arguments. */
export async function serveDaemon(
  daemon: BrowserDaemon,
  path: string,
  onRevoke?: () => void,
) {
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let input = '';
    let received = false;
    socket.setTimeout(35_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (received) return;
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 512_000) {
        socket.destroy();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        let response: BrowserResponse;
        try {
          response = await daemon.handle(JSON.parse(input.slice(0, end)));
        } catch (error) {
          response = {
            protocolVersion: '1.0',
            runtimeId: daemon.runtimeId,
            ok: false,
            events: [],
            cursor: 0,
            gap: false,
            error: fault(error),
          };
        }
        const body = JSON.stringify(response);
        if (Buffer.byteLength(body) > 1_000_000) {
          socket.end(
            JSON.stringify({
              protocolVersion: '1.0',
              runtimeId: daemon.runtimeId,
              ok: false,
              events: [],
              cursor: 0,
              gap: true,
              error: fault(
                new BrowserFault(
                  'QUOTA_EXCEEDED',
                  'The response exceeds the transport limit.',
                  'Read smaller event batches.',
                ),
              ),
            }) + '\n',
          );
          return;
        }
        socket.end(body + '\n', () => {
          if (response.ok && daemon.status().state === 'disabled') onRevoke?.();
        });
      })();
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await secureSocket(path, 0o660);
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(path, { force: true });
    },
  };
}
export function requestDaemon(
  request: BrowserRequest,
  path: string,
): Promise<BrowserResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let body = '';
    socket.setTimeout(35_000, () => {
      socket.destroy();
      reject(
        new BrowserFault(
          'OUTCOME_UNKNOWN',
          'The browser client timed out.',
          'Attach to the same invocation and inspect its receipt.',
          'possible',
        ),
      );
    });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 1_000_000) {
        socket.destroy();
        reject(
          new BrowserFault(
            'QUOTA_EXCEEDED',
            'Browser response exceeds the transport limit.',
            'Read a smaller event batch.',
          ),
        );
      }
    });
    socket.on('end', () => {
      try {
        const value: unknown = JSON.parse(body);
        if (
          !value ||
          typeof value !== 'object' ||
          Reflect.get(value, 'protocolVersion') !== '1.0' ||
          typeof Reflect.get(value, 'ok') !== 'boolean'
        )
          throw new BrowserFault(
            'PROTOCOL_MISMATCH',
            'The browser response is incompatible.',
            'Rebuild the sandbox browser image.',
          );
        resolve(value as BrowserResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}
