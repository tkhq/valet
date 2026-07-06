// @vitest-environment jsdom
//
// End-to-end beacon test: real Faro SDK init in jsdom, pushEvent, and assert
// the scrubbed POST body actually arrives at a local HTTP server. Runs with
// `instrumentations: []` — the browser instrumentations (web vitals, otel
// fetch patching) fight jsdom and are not what this test is about.
//
// The client tsconfig has `"types": []`, so node typings are pulled in
// explicitly for this test's local HTTP server.
/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initializeFaro } from '@grafana/faro-web-sdk';
import { scrubBeforeSend } from './observability';

interface ReceivedBeacon {
  url: string;
  body: string;
}

const received: ReceivedBeacon[] = [];
let server: Server;
let collectorUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  collectorUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/collect`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for beacon');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('real Faro beacon', () => {
  it('POSTs a pushed event to the collector with scrubbed attributes', async () => {
    const faro = initializeFaro({
      url: collectorUrl,
      app: { name: 'valet-client-beacon-test', version: 'test', environment: 'test' },
      instrumentations: [],
      sessionTracking: { enabled: false },
      dedupe: false,
      beforeSend: scrubBeforeSend,
    });

    faro.api.pushEvent('beacon_test', {
      leaky_url: 'https://app.valet.dev/auth/callback?code=oauth-secret',
      token: 'glc_eyJvIjoiMTIzNCJ9',
    });

    await waitFor(() =>
      received.some((beacon) => beacon.body.includes('beacon_test'))
    );

    const beacon = received.find((entry) => entry.body.includes('beacon_test'))!;
    const body = JSON.parse(beacon.body) as {
      events?: Array<{ name: string; attributes?: Record<string, string> }>;
    };
    const event = body.events?.find((entry) => entry.name === 'beacon_test');

    expect(event).toBeDefined();
    expect(event!.attributes!.leaky_url).toBe('https://app.valet.dev/auth/callback');
    expect(event!.attributes!.token).toBe('[REDACTED]');
    expect(beacon.body).not.toContain('oauth-secret');
    expect(beacon.body).not.toContain('glc_');
  });
});
