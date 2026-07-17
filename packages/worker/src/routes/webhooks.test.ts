import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../test-utils/db.js';
import { makeD1Adapter } from '../test-utils/d1.js';
import { getWebhookDeliveryStats } from '../lib/db/observability.js';
import { recordWebhookDeliveryFireAndForget } from '../lib/webhook-delivery.js';

const {
  loadGitHubAppMock,
  handlePullRequestWebhookMock,
  handlePushWebhookMock,
  handleInstallationWebhookMock,
  handleGenericWebhookMock,
} = vi.hoisted(() => ({
  loadGitHubAppMock: vi.fn(),
  handlePullRequestWebhookMock: vi.fn(),
  handlePushWebhookMock: vi.fn(),
  handleInstallationWebhookMock: vi.fn(),
  handleGenericWebhookMock: vi.fn(),
}));

vi.mock('../services/github-app.js', () => ({ loadGitHubApp: loadGitHubAppMock }));
vi.mock('../services/github-installations.js', () => ({ handleInstallationWebhook: handleInstallationWebhookMock }));
vi.mock('../services/webhooks.js', () => ({
  handlePullRequestWebhook: handlePullRequestWebhookMock,
  handlePushWebhook: handlePushWebhookMock,
  handleGenericWebhook: handleGenericWebhookMock,
}));
vi.mock('../lib/drizzle.js', () => ({ getDb: vi.fn().mockReturnValue({}) }));

import { webhooksRouter } from './webhooks.js';

function buildApp() {
  const app = new Hono();
  app.route('/webhooks', webhooksRouter);
  return app;
}

// Collect + settle every fire-and-forget waitUntil promise so DB writes land.
function makeCtx() {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p); } },
    settle: () => Promise.all(promises),
  };
}

describe('recordWebhookDeliveryFireAndForget', () => {
  let sqlite: BetterSqlite3.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    d1 = makeD1Adapter(sqlite);
  });

  it('records a row via waitUntil and swallows telemetry errors', async () => {
    const { ctx, settle } = makeCtx();
    const c = { env: { DB: d1 }, executionCtx: ctx } as never;
    recordWebhookDeliveryFireAndForget(c, { provider: 'github', eventType: 'push', outcome: 'processed' });
    await settle();

    const stats = await getWebhookDeliveryStats(d1, '2000-01-01T00:00:00.000Z');
    expect(stats).toEqual([
      expect.objectContaining({ provider: 'github', outcome: 'processed', count: 1 }),
    ]);
  });

  it('never throws even when the DB write rejects', async () => {
    const brokenDb = { prepare: () => { throw new Error('no table'); } } as unknown as D1Database;
    const { ctx, settle } = makeCtx();
    const c = { env: { DB: brokenDb }, executionCtx: ctx } as never;
    recordWebhookDeliveryFireAndForget(c, { provider: 'github', outcome: 'received' });
    await expect(settle()).resolves.toBeDefined();
  });
});

describe('POST /webhooks/github delivery recording', () => {
  let sqlite: BetterSqlite3.Database;
  let d1: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ sqlite } = createTestDb());
    d1 = makeD1Adapter(sqlite);
    handlePullRequestWebhookMock.mockResolvedValue(undefined);
    handlePushWebhookMock.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function postGithub(event: string, verifyResult: boolean) {
    loadGitHubAppMock.mockResolvedValue({
      webhooks: { verify: vi.fn().mockResolvedValue(verifyResult) },
    });
    const app = buildApp();
    const { ctx, settle } = makeCtx();
    const res = await app.request(
      '/webhooks/github',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': 'delivery-1',
          'X-Hub-Signature-256': 'sha256=deadbeef',
        },
        body: JSON.stringify({ action: 'opened', number: 1 }),
      },
      { DB: d1 } as never,
      ctx as never,
    );
    await settle();
    return res;
  }

  it('records invalid_signature and returns 401 when the signature is bad', async () => {
    const res = await postGithub('pull_request', false);
    expect(res.status).toBe(401);

    const stats = await getWebhookDeliveryStats(d1, '2000-01-01T00:00:00.000Z');
    expect(stats).toEqual([
      expect.objectContaining({ provider: 'github', outcome: 'invalid_signature', count: 1 }),
    ]);
    expect(handlePullRequestWebhookMock).not.toHaveBeenCalled();
  });

  it('records processed when a handler acts on a valid delivery', async () => {
    const res = await postGithub('pull_request', true);
    expect(res.status).toBe(200);
    expect(handlePullRequestWebhookMock).toHaveBeenCalledOnce();

    const stats = await getWebhookDeliveryStats(d1, '2000-01-01T00:00:00.000Z');
    expect(stats).toEqual([
      expect.objectContaining({ provider: 'github', outcome: 'processed', count: 1 }),
    ]);
  });

  it('records received for a valid but unhandled event', async () => {
    const res = await postGithub('star', true);
    expect(res.status).toBe(200);

    const stats = await getWebhookDeliveryStats(d1, '2000-01-01T00:00:00.000Z');
    expect(stats).toEqual([
      expect.objectContaining({ provider: 'github', outcome: 'received', count: 1 }),
    ]);
  });

  it('records failed when a handler throws', async () => {
    handlePushWebhookMock.mockRejectedValue(new Error('kaboom'));
    const res = await postGithub('push', true);
    // Still ACKs 200 so GitHub does not retry-storm.
    expect(res.status).toBe(200);

    const stats = await getWebhookDeliveryStats(d1, '2000-01-01T00:00:00.000Z');
    expect(stats).toEqual([
      expect.objectContaining({ provider: 'github', outcome: 'failed', count: 1 }),
    ]);
  });
});
