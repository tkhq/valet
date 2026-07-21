import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import * as webhookService from '../services/webhooks.js';
import { getDb } from '../lib/drizzle.js';
import { loadGitHubApp } from '../services/github-app.js';
import { handleInstallationWebhook } from '../services/github-installations.js';
import { recordWebhookDeliveryFireAndForget as recordDelivery } from '../lib/webhook-delivery.js';

export const webhooksRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Catch-all webhook handler for workflow triggers
 * Matches /webhooks/:path where :path is configured in a trigger
 */
webhooksRouter.all('/*', async (c, next) => {
  const url = new URL(c.req.url);
  const webhookPath = url.pathname.replace(/^\/webhooks\//, '');

  // Skip if it's one of the hardcoded integration webhooks
  const integrationPaths = ['github', 'notion', 'hubspot', 'discord', 'xero'];
  if (integrationPaths.includes(webhookPath.split('/')[0])) {
    return next();
  }

  const rawBody = c.req.method === 'GET' ? '' : await c.req.raw.clone().text().catch(() => '');

  // Forward the full request headers (lowercased keys) so workflows can
  // reference any inbound header via {{trigger.data.headers.X}}.
  const headers: Record<string, string | undefined> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Collect query params
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  // Strip the leading '?' so the service hashes only the pair list.
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;

  let result: Awaited<ReturnType<typeof webhookService.handleGenericWebhook>>;
  try {
    result = await webhookService.handleGenericWebhook(
      c.env,
      webhookPath,
      c.req.method,
      rawBody,
      headers,
      query,
      rawQuery,
    );
  } catch (error) {
    recordDelivery(c, {
      provider: 'generic',
      eventType: webhookPath.split('/')[0] || null,
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!result) {
    return next();
  }

  // A matched trigger fired an execution — that's an acted-on delivery.
  recordDelivery(c, {
    provider: 'generic',
    eventType: webhookPath.split('/')[0] || null,
    outcome: 'processed',
  });

  return c.json(result.result, result.statusCode as any);
});

/**
 * POST /webhooks/github
 * Handle GitHub webhook events
 */
webhooksRouter.post('/github', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery') ?? crypto.randomUUID();
  const signature = c.req.header('X-Hub-Signature-256') ?? '';

  if (!event) {
    return c.json({ error: 'Missing event header' }, 400);
  }

  const rawBody = await c.req.raw.clone().text();

  // Verify webhook signature via Octokit App
  const app = await loadGitHubApp(c.env, getDb(c.env.DB));
  if (!app) {
    return c.json({ error: 'GitHub App not configured' }, 503);
  }

  const isValid = await app.webhooks.verify(rawBody, signature);
  if (!isValid) {
    recordDelivery(c, { provider: 'github', eventType: event, outcome: 'invalid_signature' });
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(rawBody);

  console.log(`[github webhook] ${event}.${payload.action ?? ''} (${deliveryId})`);

  // Track the delivery outcome: a matched handler that ran → 'processed';
  // a handler that threw → 'failed'; an event we don't act on → 'received'.
  let acted = false;
  let handlerError: unknown;

  // Installation lifecycle events — sync to github_installations table
  if (event === 'installation' && ['created', 'deleted', 'suspend', 'unsuspend'].includes(payload.action)) {
    try {
      await handleInstallationWebhook(getDb(c.env.DB), payload);
      acted = true;
    } catch (error) {
      handlerError = error;
      console.error('[github webhook] installation handler error:', error);
    }
  }

  // Pull request events — session state management + App-driven workflows
  if (event === 'pull_request') {
    try {
      await webhookService.handlePullRequestWebhook(c.env, payload);
      acted = true;
    } catch (error) {
      handlerError = error;
      console.error('[github webhook] pull_request handler error:', error);
    }
    // Fan the event out to any github-app triggers scoped to this repo (the
    // "wire it up via the App" alternative to a per-workflow webhook).
    try {
      await webhookService.dispatchGithubAppReviews(c.env, event, payload, deliveryId);
    } catch (error) {
      console.error('[github webhook] github-app dispatch error:', error);
    }
  }

  // Issue-comment events — App-driven re-review on an @Valet mention.
  if (event === 'issue_comment') {
    try {
      await webhookService.dispatchGithubAppReviews(c.env, event, payload, deliveryId);
    } catch (error) {
      console.error('[github webhook] issue_comment dispatch error:', error);
    }
  }

  // Push events — session state management
  if (event === 'push') {
    try {
      await webhookService.handlePushWebhook(c.env, payload);
      acted = true;
    } catch (error) {
      handlerError = error;
      console.error('[github webhook] push handler error:', error);
    }
  }

  // TODO: route unhandled events to org orchestrator for automation rules
  const handled = new Set(['installation', 'pull_request', 'push', 'issue_comment']);
  if (!handled.has(event)) {
    console.log(`[github webhook] unhandled event: ${event}.${payload.action ?? ''}`);
  }

  recordDelivery(c, {
    provider: 'github',
    eventType: event,
    outcome: handlerError ? 'failed' : acted ? 'processed' : 'received',
    error: handlerError ? (handlerError instanceof Error ? handlerError.message : String(handlerError)) : null,
  });

  // Always return 200 — failing to ACK causes GitHub to retry and amplify errors
  return c.json({ received: true, event, deliveryId });
});

/**
 * POST /webhooks/notion
 */
webhooksRouter.post('/notion', async (c) => {
  const payload = await c.req.json();
  console.log('Notion webhook:', payload);
  return c.json({ received: true });
});

/**
 * POST /webhooks/hubspot
 */
webhooksRouter.post('/hubspot', async (c) => {
  const signature = c.req.header('X-HubSpot-Signature');
  const payload = await c.req.json();

  console.log('HubSpot webhook:', payload);

  if (Array.isArray(payload)) {
    for (const event of payload) {
      console.log(`HubSpot event: ${event.subscriptionType}`);
    }
  }

  return c.json({ received: true });
});

/**
 * POST /webhooks/discord
 */
webhooksRouter.post('/discord', async (c) => {
  const signature = c.req.header('X-Signature-Ed25519');
  const timestamp = c.req.header('X-Signature-Timestamp');
  const payload = await c.req.json();

  if (payload.type === 1) {
    return c.json({ type: 1 });
  }

  console.log('Discord webhook:', payload);
  return c.json({ received: true });
});

/**
 * POST /webhooks/xero
 */
webhooksRouter.post('/xero', async (c) => {
  const signature = c.req.header('x-xero-signature');
  const payload = await c.req.json();

  console.log('Xero webhook:', payload);

  if (payload.events && Array.isArray(payload.events)) {
    for (const event of payload.events) {
      console.log(`Xero event: ${event.eventType} for ${event.resourceId}`);
    }
  }

  return c.json({ received: true });
});
