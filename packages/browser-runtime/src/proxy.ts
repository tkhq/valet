import { createServer, request } from 'node:http';
import { createConnection, type Socket } from 'node:net';

class BrokerError extends Error {
  constructor(
    readonly statusCode: 403 | 502,
    message: string,
  ) {
    super(message);
  }
}
export function createNamespaceProxy(socketPath: string) {
  function connect(host: string, port: number, signal?: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: socketPath, signal });
      socket.on('error', reject);
      socket.once('close', () => reject(Error('Browser broker connection closed.')));
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ host, port })}\n`),
      );
      let buffered = Buffer.alloc(0);
      const handshake = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf(10);
        if (end < 0) return;
        socket.off('data', handshake);
        const response = buffered.subarray(0, end).toString();
        if (response !== 'OK') {
          socket.destroy();
          if (response.startsWith('UNAVAILABLE ')) {
            const destination = response.slice(12);
            const message = destination.startsWith('localhost:')
              ? `Nothing is listening on ${destination} (tried 127.0.0.1 and ::1).`
              : `Cannot connect to ${destination}.`;
            reject(new BrokerError(502, message));
          } else reject(new BrokerError(403, 'Browser origin denied.'));
          return;
        }
        const rest = buffered.subarray(end + 1);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      };
      socket.on('data', handshake);
    });
  }
  const proxy = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? '');
      if (url.protocol !== 'http:') throw Error('HTTP proxy protocol denied.');
      const socket = await connect(url.hostname, Number(url.port || 80));
      const headers = { ...incoming.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = request(
        {
          hostname: url.hostname,
          port: Number(url.port || 80),
          method: incoming.method,
          path: url.pathname + url.search,
          headers,
          createConnection: () => socket,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('error', () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    })().catch((error: unknown) => {
      const brokerError = error instanceof BrokerError ? error : new BrokerError(403, 'Browser origin denied.');
      outgoing.writeHead(brokerError.statusCode);
      outgoing.end(brokerError.message);
    });
  });
  proxy.on('connect', (incoming, client, head) => {
    // A client can reset while the broker handshake is pending.
    const controller = new AbortController();
    client.on('error', () => controller.abort());
    client.on('close', () => controller.abort());
    void (async () => {
      const url = new URL(`https://${incoming.url}`);
      const upstream = await connect(url.hostname, Number(url.port || 443), controller.signal);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { if (!upstream.readableEnded) client.destroy(); });
    })().catch((error: unknown) => {
      const brokerError = error instanceof BrokerError ? error : new BrokerError(403, 'Browser origin denied.');
      if (!client.destroyed)
        client.end(`HTTP/1.1 ${brokerError.statusCode} ${brokerError.statusCode === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: ${Buffer.byteLength(brokerError.message)}\r\n\r\n${brokerError.message}`);
    });
  });
  proxy.on('upgrade', (incoming, client, head) => {
    const controller = new AbortController();
    client.on('error', () => controller.abort());
    client.on('close', () => controller.abort());
    void (async () => {
      const url = new URL(incoming.url ?? '');
      if (url.protocol !== 'http:' && url.protocol !== 'ws:')
        throw Error('WebSocket protocol denied.');
      const upstream = await connect(url.hostname, Number(url.port || 80), controller.signal);
      if (client.destroyed) { upstream.destroy(); return; }
      upstream.write(
        `${incoming.method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(
          incoming.headers,
        )
          .filter(([key]) => !key.startsWith('proxy-'))
          .map(
            ([key, value]) =>
              `${key}: ${Array.isArray(value) ? value.join(',') : value}`,
          )
          .join('\r\n')}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { if (!upstream.readableEnded) client.destroy(); });
    })().catch((error: unknown) => {
      const brokerError = error instanceof BrokerError ? error : new BrokerError(403, 'Browser origin denied.');
      if (!client.destroyed)
        client.end(`HTTP/1.1 ${brokerError.statusCode} ${brokerError.statusCode === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: ${Buffer.byteLength(brokerError.message)}\r\n\r\n${brokerError.message}`);
    });
  });
  return proxy;
}
