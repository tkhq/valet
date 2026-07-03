import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency } from './executions.js';
import { dispatchWorkflowExecution } from './workflow-dispatch.js';
import { sha256Hex } from '../lib/hash.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { WEBHOOK_RATE_LIMIT_DEFAULT, bumpWebhookRateCount } from '../lib/db.js';
import { getServiceConfig } from '../lib/db/service-configs.js';

// Row shape shared by the id-based lookup (getWebhookTriggerById, used
// by /api/triggers/:id/webhook with token auth) and the path-based
// lookup (lookupWebhookTrigger, used by /webhooks/:path with optional
// config.secret). Both lookups now include webhook_token so the path
// handler can refuse tokenized triggers — once a token is minted on a
// row, /webhooks/:path is closed for it and the token URL is the only
// supported entry.
export interface TriggerWebhookRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  user_id: string;
  version: string | null;
  data: string;
  config: string;
  variable_mapping: string | null;
  webhook_token?: string | null;
}

/**
 * Per-trigger rate limit check. Returns the new count after this
 * request and whether the request should be rejected. Schedule and
 * manual triggers don't call this — it's webhook-only.
 *
 * The rate-limit window is a fixed 60-second bucket keyed by unix
 * second truncated to a minute boundary. Slightly bursty across bucket
 * boundaries but cheap to implement on D1 and fine for our scale.
 */
export async function checkWebhookRateLimit(
  env: Env,
  triggerId: string,
  config: { rateLimit?: number },
): Promise<{ allowed: boolean; count: number; limit: number; retryAfter: number }> {
  const limit = typeof config.rateLimit === 'number' && config.rateLimit > 0
    ? Math.floor(config.rateLimit)
    : WEBHOOK_RATE_LIMIT_DEFAULT;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 60);
  const count = await bumpWebhookRateCount(env.DB, triggerId, windowStart);
  const retryAfter = 60 - (nowSec - windowStart);
  return { allowed: count <= limit, count, limit, retryAfter };
}

/**
 * Canonicalize a raw URL query string (no leading '?') for use as part
 * of the webhook idempotency hash.
 *
 * The parsed query Record collapses duplicate keys and decodes percent
 * escapes — both lose information needed to distinguish distinct
 * deliveries. We canonicalize at the RAW pair level so:
 *   - duplicate keys are preserved: ?tag=a&tag=b ≠ ?tag=b
 *   - URL-encoded characters stay distinct from their decoded forms:
 *     ?a=1%26b%3D2 ≠ ?a=1&b=2
 *
 * Sorting the raw pairs lexicographically also makes the result
 * order-independent (?a=1&b=2 ≡ ?b=2&a=1).
 *
 * Exported for direct unit testing.
 */
export function canonicalizeRawQuery(rawQuery: string): string {
  return rawQuery
    .split('&')
    .filter((pair) => pair.length > 0)
    .sort()
    .join('&');
}

/**
 * Validate the X-Valet-Trigger-Token header against the trigger row.
 * Returns true on a constant-time match. Triggers created before the
 * webhook_token column may have null webhook_token — in that case this
 * returns false and the caller decides whether to fall back to the
 * path-based secret check (only the /webhooks/:path route does so).
 */
export function verifyTriggerToken(
  row: { webhook_token?: string | null },
  header: string | undefined,
): boolean {
  if (!row.webhook_token || !header) return false;
  return constantTimeEqual(row.webhook_token, header);
}

// ─── Generic Webhook Handler ────────────────────────────────────────────────

export interface GenericWebhookResult {
  received: true;
  executionId?: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  dispatched?: boolean;
  deduplicated?: boolean;
  queued?: boolean;
  message: string;
  error?: string;
  reason?: string;
  activeUser?: number;
  activeGlobal?: number;
}

export async function handleGenericWebhook(
  env: Env,
  webhookPath: string,
  method: string,
  rawBody: string,
  headers: { [key: string]: string | undefined },
  query: Record<string, string>,
  rawQuery: string = '',
): Promise<{ result: GenericWebhookResult; statusCode: number } | null> {
  // Path-based entry point used by /webhooks/:path. Looks up the trigger
  // by config.path and defers to dispatchWebhookForTrigger after the
  // secret + rate-limit checks. Triggers created via the token model
  // are reached through /api/triggers/:id/webhook instead.
  const trigger = await db.lookupWebhookTrigger(env.DB, webhookPath);

  if (!trigger) {
    return {
      result: { received: true, message: 'Webhook not found' } as any,
      statusCode: 404,
    };
  }

  // Tokenized triggers refuse the path-based route entirely. The token
  // URL (POST /api/triggers/:id/webhook with X-Valet-Trigger-Token) is
  // the only supported entry once a token has been minted on the row.
  // Without this gate, an operator who configured "token-protected
  // webhook" with no legacy secret would still accept unauthenticated
  // hits at /webhooks/<path> — an auth bypass. Returning 404 (rather
  // than 401) refuses without revealing which trigger the path maps to.
  if (trigger.webhook_token) {
    return {
      result: { received: true, message: 'Webhook not found' } as any,
      statusCode: 404,
    };
  }

  const config = JSON.parse(trigger.config as string) as {
    method?: string;
    secret?: string;
    rateLimit?: number;
  };

  // Verify HTTP method if specified
  if (config.method && config.method !== method) {
    return {
      result: { received: true, message: `Method ${method} not allowed` } as any,
      statusCode: 405,
    };
  }

  // Secret check for the path-based webhook route. The forward-facing
  // /api/triggers/:id/webhook route uses a server-issued token instead.
  // Constant-time compare against config.secret — a header-presence
  // check would be an auth bypass.
  if (config.secret) {
    const signature = headers['x-webhook-signature'] || headers['x-hub-signature-256'];
    if (!signature || !constantTimeEqual(String(config.secret), signature)) {
      return {
        result: { received: true, message: 'Missing or invalid webhook signature' } as any,
        statusCode: 401,
      };
    }
  }

  // Per-trigger rate limit applies on the path-based route too.
  const rate = await checkWebhookRateLimit(env, trigger.id, config);
  if (!rate.allowed) {
    return {
      result: {
        received: true,
        queued: false,
        error: 'rate_limited',
        reason: 'rate_limited',
        message: `Webhook rate limit exceeded (${rate.count}/${rate.limit} per 60s).`,
      },
      statusCode: 429,
    };
  }

  return dispatchWebhookForTrigger(env, trigger, webhookPath, method, rawBody, headers, query, rawQuery);
}

/**
 * Authenticated webhook entry point used by
 * POST /api/triggers/:triggerId/webhook. The route handler is
 * responsible for verifying the X-Valet-Trigger-Token + rate limit
 * before calling here. webhookPath is whatever the trigger's
 * config.path is, for backward-compat metadata only.
 */
export async function dispatchWebhookForTrigger(
  env: Env,
  trigger: TriggerWebhookRow,
  webhookPath: string,
  method: string,
  rawBody: string,
  headers: { [key: string]: string | undefined },
  query: Record<string, string>,
  // Raw URL search string (without the leading '?'). Required for the
  // duplicate-safe, encoding-stable idempotency hash below — the parsed
  // `query` Record collapses duplicate keys and decodes values, both of
  // which lose information needed to distinguish distinct deliveries.
  rawQuery: string = '',
): Promise<{ result: GenericWebhookResult; statusCode: number }> {
  const appDb = getDb(env.DB);

  // Parse request body. Non-JSON bodies are surfaced as the raw string
  // under `body` so workflows can still inspect them via
  // {{trigger.data.body}} — JSON.parse failure is not an error here.
  let parsedBody: unknown = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  // Strip undefined values from headers so downstream template lookups
  // see a clean Record<string, string>.
  const cleanHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') cleanHeaders[k] = v;
  }

  // Spec §"Webhook trigger payload": trigger.data carries the
  // normalized request (body / headers / query / method). Authors
  // reference it as {{trigger.data.body}}, {{trigger.data.headers.X}},
  // etc. The pre-fix shape dumped only variableMapping fields into
  // trigger.data, which silently broke any workflow that didn't ship
  // an exhaustive mapping — including {{trigger.data.body}} examples.
  const normalizedPayload: Record<string, unknown> = {
    body: parsedBody,
    headers: cleanHeaders,
    query,
    method,
  };

  // variableMapping is a per-trigger user-friendly extraction layer.
  // It traverses the parsed body (with `query` merged in under .query)
  // and surfaces named values directly as trigger.data parameters.
  const variableMapping = trigger.variable_mapping
    ? JSON.parse(trigger.variable_mapping as string)
    : {};

  // Extraction scope: the parsed body merged with `query` under .query,
  // so mappings like `$.user.email` or `$.query.token` resolve against
  // a single dotted-path namespace.
  const extractScope: Record<string, unknown> =
    parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? { ...(parsedBody as Record<string, unknown>) }
      : {};
  if (Object.keys(query).length > 0) {
    extractScope.query = query;
  }

  const extractedTriggerData: Record<string, unknown> = {};
  for (const [varName, pathExpr] of Object.entries(variableMapping)) {
    const pathStr = pathExpr as string;
    if (!pathStr.startsWith('$.')) continue;
    const parts = pathStr.slice(2).split('.');
    let value: unknown = extractScope;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined) {
      extractedTriggerData[varName] = value;
    }
  }
  const workflowTriggerData = Object.keys(extractedTriggerData).length > 0
    ? extractedTriggerData
    : normalizedPayload;

  const deliveryId = headers['x-github-delivery']
    || headers['x-request-id']
    || headers['x-webhook-id']
    || null;
  const signature = headers['x-webhook-signature']
    || headers['x-hub-signature-256']
    || '';
  // GET deliveries have no body and rarely have a signature, so a
  // signature:body hash collapses every GET into one idempotency key.
  // Mix in the method and a canonicalized query string so distinct GETs
  // hash differently. See canonicalizeRawQuery for the duplicate/encoding
  // properties this needs to preserve.
  const canonicalQuery = canonicalizeRawQuery(rawQuery);
  const fallbackBodyHash = await sha256Hex(`${method}:${signature}:${rawBody}:${canonicalQuery}`);
  // Include user_id in the idempotency key so two tenants with the
  // same delivery id can't collide on workflow_executions inserts.
  const idempotencyKey = `webhook:${trigger.user_id}:${trigger.id}:${deliveryId || fallbackBodyHash}`;
  const triggerMetadata = {
    path: webhookPath,
    method,
    deliveryId,
  };

  const existing = await db.checkIdempotencyKey(env.DB, trigger.workflow_id, trigger.user_id, idempotencyKey);

  if (existing) {
    return {
      result: {
        received: true,
        deduplicated: true,
        executionId: existing.id as string,
        workflowId: trigger.workflow_id,
        workflowName: trigger.workflow_name,
        status: existing.status as string,
        message: 'Webhook received. Existing workflow execution reused.',
      },
      statusCode: 200,
    };
  }

  const concurrency = await checkWorkflowConcurrency(appDb, trigger.user_id);
  if (!concurrency.allowed) {
    return {
      result: {
        received: true,
        queued: false,
        error: 'Too many concurrent workflow executions',
        reason: concurrency.reason,
        activeUser: concurrency.activeUser,
        activeGlobal: concurrency.activeGlobal,
        message: 'Webhook received but rate limited.',
      },
      statusCode: 429,
    };
  }

  const result = await dispatchWorkflowExecution(env, {
    workflowId: trigger.workflow_id,
    user: { id: trigger.user_id },
    trigger: {
      type: 'webhook',
      triggerId: trigger.id,
      timestamp: new Date().toISOString(),
      data: workflowTriggerData,
      metadata: triggerMetadata,
    },
    idempotencyKey,
  });
  if (result.status === 'rejected') {
    // Failures shouldn't bump last_run_at — only successful dispatch
    // counts as a "run". Catch-up logic would otherwise misread the
    // last-run cursor.
    const statusCode = result.reason === 'rate_limited' ? 429 : 400;
    return {
      result: {
        received: true,
        queued: false,
        error: result.reason ?? 'workflow start failed',
        reason: result.reason,
        activeUser: concurrency.activeUser,
        activeGlobal: concurrency.activeGlobal,
        message: result.reason === 'rate_limited'
          ? 'Webhook received but rate limited.'
          : 'Webhook received but workflow could not start.',
      },
      statusCode,
    };
  }
  await db.updateTriggerLastRunUnchecked(appDb, trigger.id, new Date().toISOString());
  return {
    result: {
      received: true,
      executionId: result.executionId,
      workflowId: trigger.workflow_id,
      workflowName: trigger.workflow_name,
      status: 'pending',
      dispatched: true,
      message: 'Webhook received. Workflow execution queued.',
    },
    statusCode: 200,
  };
}

// ─── Pull Request Webhook Handler ───────────────────────────────────────────

export async function handlePullRequestWebhook(env: Env, payload: any): Promise<void> {
  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) return;

  const repoFullName = payload.repository?.full_name;
  const prNumber = pr.number;

  if (!repoFullName || !prNumber) return;

  const appDb = getDb(env.DB);
  const rows = await db.findSessionsByPR(appDb, repoFullName, prNumber);

  if (!rows.results || rows.results.length === 0) return;

  let prState: string;
  if (pr.merged_at || action === 'closed' && pr.merged) {
    prState = 'merged';
  } else if (action === 'closed') {
    prState = 'closed';
  } else if (action === 'reopened' || action === 'opened') {
    prState = pr.draft ? 'draft' : 'open';
  } else {
    prState = pr.draft ? 'draft' : (pr.state === 'open' ? 'open' : pr.state);
  }

  for (const row of rows.results) {
    const sessionId = row.session_id;

    await db.updateSessionGitState(appDb, sessionId, {
      prState: prState as any,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prMergedAt: pr.merged_at || undefined,
    });

    try {
      const doId = env.SESSIONS.idFromName(sessionId);
      const stub = env.SESSIONS.get(doId);
      await stub.fetch(new Request('https://session/webhook-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'git-state-update',
          prState,
          prTitle: pr.title,
          prUrl: pr.html_url,
          prMergedAt: pr.merged_at || null,
        }),
      }));
    } catch (err) {
      console.error(`Failed to notify DO for session ${sessionId}:`, err);
    }
  }
}

// ─── GitHub App → Workflow Dispatch ─────────────────────────────────────────

/** What warrants a review for a delivered GitHub App event, or null to skip. */
export interface ReviewDecision {
  owner: string;
  repo: string;
  pullNumber: number;
  /** 'initial' = first review on open/ready; 'mention' = re-review on @Valet. */
  reason: 'initial' | 'mention';
}

/**
 * Greptile-style review policy. Decides whether a delivered GitHub App event
 * should trigger a PR review:
 *   • pull_request opened/reopened/ready_for_review, NOT draft → initial review.
 *   • pull_request synchronize (a push) and drafts → SKIP (no auto re-review).
 *   • issue_comment on a PR that @-mentions "@Valet" (not from a bot) → re-review.
 * Everything else is skipped. Returned null means "do nothing".
 */
export function decideReview(
  event: string,
  payload: Record<string, unknown>,
  botSlug: string | null,
): ReviewDecision | null {
  const repository = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo) return null;

  if (event === 'pull_request') {
    const pr = payload.pull_request as { number?: number; draft?: boolean } | undefined;
    if (!pr?.number) return null;
    // Never review a draft PR.
    if (pr.draft === true) return null;
    // Review once — on open, reopen, or the draft→ready transition. Deliberately
    // NOT on 'synchronize' (a push): like Greptile, re-review only on @-mention.
    const action = payload.action;
    if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
      return { owner, repo, pullNumber: pr.number, reason: 'initial' };
    }
    return null;
  }

  if (event === 'issue_comment') {
    if (payload.action !== 'created') return null;
    // issue_comment fires for issues AND PRs; only PRs carry issue.pull_request.
    const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined;
    if (!issue?.number || !issue.pull_request) return null;
    const comment = payload.comment as { body?: string; user?: { type?: string } } | undefined;
    // Loop guard: never react to a bot's own comment (incl. our own reviews).
    if (comment?.user?.type === 'Bot') return null;
    // Re-review only when the comment @-mentions THIS App's bot handle — the
    // installed App's slug, e.g. `@valet-turnkey` or the bot login
    // `@valet-turnkey[bot]`. Matching the generic word "valet" would ping an
    // unrelated GitHub user (github.com/valet is a real account). Without a
    // configured slug there's no bot to mention, so never match.
    if (!botSlug) return null;
    if (!mentionsBot(String(comment?.body ?? ''), botSlug)) return null;
    return { owner, repo, pullNumber: issue.number, reason: 'mention' };
  }

  return null;
}

/** True when the comment @-mentions the App by its slug or `<slug>[bot]` login. */
export function mentionsBot(body: string, botSlug: string): boolean {
  const slug = botSlug.replace(/\[bot\]$/i, '');
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // @<slug> or @<slug>[bot], case-insensitive, not part of a longer handle.
  return new RegExp(`@${esc}(\\[bot\\])?(?![a-z0-9-])`, 'i').test(body);
}

/**
 * Dispatch a GitHub App event to every `github-app` trigger scoped to the
 * event's repo — the App-driven alternative to a per-workflow webhook. The
 * Greptile-style policy (decideReview) gates it: drafts and pushes are skipped,
 * the initial review fires on open/ready, and re-reviews happen only on an
 * @Valet mention. Each matching workflow runs once per delivery (idempotency-
 * keyed on the delivery id). Best-effort: one failure never blocks the 200 ACK.
 */
export async function dispatchGithubAppReviews(
  env: Env,
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  // Resolve the App's own slug so an @-mention re-review matches THIS bot's
  // handle (`@<slug>` / `@<slug>[bot]`), not the generic word "valet". Only
  // needed for issue_comment; skip the config read for pull_request events.
  let botSlug: string | null = null;
  if (event === 'issue_comment') {
    const svc = await getServiceConfig<{ appSlug?: string }>(getDb(env.DB), env.ENCRYPTION_KEY, 'github').catch(() => null);
    botSlug = svc?.config.appSlug ?? null;
  }

  const decision = decideReview(event, payload, botSlug);
  if (!decision) return;
  const { owner, repo, pullNumber, reason } = decision;

  const triggers = await db.findGithubAppTriggersForRepo(env.DB, owner, repo);
  if (triggers.length === 0) return;

  for (const trigger of triggers) {
    try {
      const config = JSON.parse(trigger.config) as { events?: string[] };
      // Only fire triggers subscribed to this GitHub event.
      if (config.events && !config.events.includes(event)) continue;

      await dispatchWorkflowExecution(env, {
        workflowId: trigger.workflow_id,
        user: { id: trigger.user_id },
        trigger: {
          type: 'webhook',
          triggerId: trigger.id,
          timestamp: new Date().toISOString(),
          // No `action` → the template's gate passes via its isEmpty arm; the
          // review-vs-skip decision has already been made above.
          data: { owner, repo, pullNumber },
          metadata: { source: 'github-app', event, deliveryId, reason },
        },
        // One execution per delivery per trigger — GitHub retries redeliver the
        // same X-GitHub-Delivery, so this dedupes at the executions unique index.
        idempotencyKey: `github-app:${trigger.id}:${deliveryId}`,
      });
    } catch (err) {
      console.error(`[github-app dispatch] trigger ${trigger.id} failed:`, err);
    }
  }
}

// ─── Push Webhook Handler ───────────────────────────────────────────────────

export async function handlePushWebhook(env: Env, payload: any): Promise<void> {
  const ref = payload.ref;
  const repoFullName = payload.repository?.full_name;
  const commitCount = payload.commits?.length ?? 0;

  if (!ref || !repoFullName || commitCount === 0) return;

  const branch = ref.replace('refs/heads/', '');

  const appDb = getDb(env.DB);
  const rows = await db.findSessionsByRepoBranch(appDb, repoFullName, branch);

  if (!rows.results || rows.results.length === 0) return;

  for (const row of rows.results) {
    await db.updateSessionGitState(appDb, row.session_id, {
      commitCount: row.commit_count + commitCount,
    });

    try {
      const doId = env.SESSIONS.idFromName(row.session_id);
      const stub = env.SESSIONS.get(doId);
      await stub.fetch(new Request('https://session/webhook-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'git-state-update',
          commitCount: row.commit_count + commitCount,
          branch,
        }),
      }));
    } catch (err) {
      console.error(`Failed to notify DO for session ${row.session_id}:`, err);
    }
  }
}
