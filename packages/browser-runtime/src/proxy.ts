import { createServer, request } from 'node:http';
import { createConnection, type Socket } from 'node:net';
export function createNamespaceProxy(socketPath: string) {
  function connect(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ host, port })}\n`),
      );
      let buffered = Buffer.alloc(0);
      const handshake = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf(10);
        if (end < 0) return;
        socket.off('data', handshake);
        if (buffered.subarray(0, end).toString() !== 'OK') {
          socket.destroy();
          reject(Error('Browser origin denied.'));
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
    })().catch(() => {
      outgoing.writeHead(403);
      outgoing.end('Browser origin denied.');
    });
  });
  proxy.on('connect', (incoming, client, head) => {
    void (async () => {
      const url = new URL(`https://${incoming.url}`);
      const upstream = await connect(url.hostname, Number(url.port || 443));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  });
  proxy.on('upgrade', (incoming, client, head) => {
    void (async () => {
      const url = new URL(incoming.url ?? '');
      if (url.protocol !== 'http:' && url.protocol !== 'ws:')
        throw Error('WebSocket protocol denied.');
      const upstream = await connect(url.hostname, Number(url.port || 80));
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
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    })().catch(() => client.destroy());
  });
  return proxy;
}
