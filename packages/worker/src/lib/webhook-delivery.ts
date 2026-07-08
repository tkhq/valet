import type { Context } from 'hono';
import type { Env, Variables } from '../env.js';
import { recordWebhookDelivery, type RecordWebhookDeliveryInput } from './db/observability.js';

/**
 * Record one webhook_deliveries row fire-and-forget from an inbound webhook
 * route. Runs under ctx.executionCtx.waitUntil and swallows its own errors so
 * telemetry can NEVER delay or break a webhook ACK — GitHub/Slack/Telegram all
 * retry aggressively on non-200s, and a broken webhook_deliveries table must not
 * amplify that.
 */
export function recordWebhookDeliveryFireAndForget(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  input: RecordWebhookDeliveryInput,
): void {
  c.executionCtx.waitUntil(recordWebhookDelivery(c.env.DB, input).catch(() => {}));
}
