import type { Env } from '../env.js';
import type { PRState } from '@valet/shared';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import type { AppDb } from '../lib/drizzle.js';
import { checkWorkflowConcurrency } from './executions.js';
import { dispatchWorkflowExecution } from './workflow-dispatch.js';
import { sha256Hex } from '../lib/hash.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { WEBHOOK_RATE_LIMIT_DEFAULT, bumpWebhookRateCount } from '../lib/db.js';
import { getServiceConfig } from '../lib/db/service-configs.js';
import { getGitHubMetadata } from './github-config.js';

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
  let workflowTriggerData = Object.keys(extractedTriggerData).length > 0
    ? extractedTriggerData
    : normalizedPayload;

  // Repo-pinned code-review triggers (installed from the code-review template)
  // carry the repository they were armed for on their config. Everything the
  // App-delivery path decides — is this the right repo, is the author trusted,
  // does org/owner policy still want reviews — has to hold here too, or the
  // manual-webhook install is simply a way around it.
  const triggerConfig = JSON.parse(trigger.config as string) as {
    github?: { codeReview?: boolean; owner?: string; repo?: string };
  };
  const pin = triggerConfig.github;
  if (pin?.codeReview && pin.owner && pin.repo) {
    const gate = await gateCodeReviewDelivery(env, appDb, {
      event: headers['x-github-event'] ?? 'pull_request',
      payload: (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
        ? parsedBody as Record<string, unknown>
        : {}),
      pinnedOwner: pin.owner,
      pinnedRepo: pin.repo,
      triggerUserId: trigger.user_id,
    });
    if (gate.outcome === 'wrong_repo') {
      return {
        result: {
          received: true,
          queued: false,
          error: 'repo_not_allowed',
          reason: 'repo_not_allowed',
          message: `This trigger is armed for ${pin.owner}/${pin.repo} only.`,
        },
        statusCode: 403,
      };
    }
    if (gate.outcome === 'skip') {
      return {
        result: { received: true, dispatched: false, message: 'Webhook received. No review warranted.' },
        statusCode: 200,
      };
    }
    // Take the review scope from the gate, not from the raw body: the pinned
    // owner/repo win, and the PR number is the one the policy just approved.
    workflowTriggerData = { owner: pin.owner, repo: pin.repo, pullNumber: gate.decision.pullNumber };
  }

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
  const prMatches = await db.findSessionsByPR(appDb, repoFullName, prNumber);

  // Sessions matched by pr_number authored this PR; matches via
  // source_pr_number were merely spawned FROM it and must never have the
  // payload's number stamped as their own output.
  const targets: Array<{ sessionId: string; authored: boolean }> = (prMatches.results ?? []).map((r) => ({
    sessionId: r.session_id,
    authored: r.pr_number === prNumber,
  }));

  // A session that just opened this PR from its sandbox is not linked yet
  // (nothing stamps pr_number at creation time) — link it via its head
  // branch. Skip rows already tied to a different PR.
  const headBranch: string | undefined = pr.head?.ref;
  if (headBranch) {
    const seen = new Set(targets.map((t) => t.sessionId));
    const branchMatches = await db.findSessionsByRepoBranch(appDb, repoFullName, headBranch);
    for (const bm of branchMatches.results ?? []) {
      if (!seen.has(bm.session_id) && bm.pr_number == null) {
        targets.push({ sessionId: bm.session_id, authored: true });
      }
    }
  }

  if (targets.length === 0) return;

  let prState: PRState;
  if (pr.merged_at || action === 'closed' && pr.merged) {
    prState = 'merged';
  } else if (action === 'closed') {
    prState = 'closed';
  } else if (action === 'reopened' || action === 'opened') {
    prState = pr.draft ? 'draft' : 'open';
  } else {
    // GitHub pull_request.state is only ever 'open' | 'closed'.
    prState = pr.draft ? 'draft' : (pr.state === 'open' ? 'open' : 'closed');
  }

  for (const { sessionId, authored } of targets) {
    await db.updateSessionGitState(appDb, sessionId, {
      prState,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prMergedAt: pr.merged_at || undefined,
      ...(authored
        ? {
            prNumber,
            ...(pr.created_at ? { prCreatedAt: pr.created_at } : {}),
          }
        : {}),
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
 * Author associations that count as "somebody who belongs to this repository".
 * GitHub reports this per PR and per comment; anything else (CONTRIBUTOR,
 * FIRST_TIME_CONTRIBUTOR, NONE, …) is an outsider.
 */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Whether a pull request comes from somebody the repository already trusts —
 * the branch lives in the repository itself (not a fork), or the author is an
 * owner/member/collaborator.
 *
 * A review run spends money on an LLM call and publishes a review under the
 * org's App identity, so an unaffiliated fork PR must not be able to summon
 * one. This is the safe default; loosening it is an org-level product decision.
 */
function isTrustedPullRequest(
  pr: {
    head?: { repo?: { full_name?: string | null } | null };
    author_association?: string;
  } | undefined,
  owner: string,
  repo: string,
): boolean {
  if (!pr) return false;
  const headRepo = pr.head?.repo?.full_name;
  if (typeof headRepo === 'string' && headRepo.toLowerCase() === `${owner}/${repo}`.toLowerCase()) {
    return true;
  }
  return TRUSTED_ASSOCIATIONS.has(String(pr.author_association ?? '').toUpperCase());
}

/** Whether a comment's author belongs to the repository. */
function isTrustedCommenter(comment: { author_association?: string } | undefined): boolean {
  return TRUSTED_ASSOCIATIONS.has(String(comment?.author_association ?? '').toUpperCase());
}

/**
 * Greptile-style review policy. Decides whether a delivered GitHub App event
 * should trigger a PR review:
 *   • pull_request opened/reopened/ready_for_review, NOT draft, from someone
 *     the repo trusts → initial review.
 *   • pull_request synchronize (a push) and drafts → SKIP (no auto re-review).
 *   • issue_comment on a PR that @-mentions "@Valet", from a trusted human
 *     (not a bot) → re-review.
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
    const pr = payload.pull_request as {
      number?: number;
      draft?: boolean;
      head?: { repo?: { full_name?: string | null } | null };
      author_association?: string;
    } | undefined;
    if (!pr?.number) return null;
    // Never review a draft PR.
    if (pr.draft === true) return null;
    // Never review on behalf of an outsider: a fork PR from someone with no
    // standing in the repo would otherwise buy an LLM run and an App-authored
    // review from anyone on GitHub.
    if (!isTrustedPullRequest(pr, owner, repo)) return null;
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
    const comment = payload.comment as {
      body?: string;
      user?: { type?: string };
      author_association?: string;
    } | undefined;
    // Loop guard: never react to a bot's own comment (incl. our own reviews).
    if (comment?.user?.type === 'Bot') return null;
    // Only somebody who belongs to the repository can summon a re-review;
    // otherwise a drive-by comment triggers a paid run and an App-signed review.
    if (!isTrustedCommenter(comment)) return null;
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

/** ORG-scoped code-review policy (from GitHubServiceMetadata.codeReview*). */
export interface CodeReviewOrgPolicy {
  enabled: boolean;
  enforced: boolean;
  mentionOnly: boolean;
}
/** Per-owner code-review prefs (from users.code_review_*). */
export interface CodeReviewOwnerPrefs {
  enabled: boolean;
  mentionOnly: boolean;
}

/**
 * Decide whether a code-review dispatch should proceed for one armed trigger,
 * given the ORG policy, the repo OWNER's preferences, and why review fired
 * (`initial` = PR opened/reopened/ready; `mention` = @bot re-review request).
 *
 * Precedence mirrors `resolveEffectiveActionPolicy`: the org value is a hard
 * ceiling and the owner may only LOOSEN (make it quieter) within it — never
 * tighten past the org, never override an org OFF.
 *  - Org disabled  → absolute OFF          (analog: admin `deny` short-circuit)
 *  - Org enforced  → owner prefs ignored    (analog: userGrantBehavior 'blocked')
 *  - Owner opt-out → OFF for their repos    (a loosening: they want none)
 *  - Mention-only  → skip `initial`, keep `mention`; org OR owner may set it
 */
export function resolveCodeReviewGate(
  org: CodeReviewOrgPolicy,
  owner: CodeReviewOwnerPrefs | null,
  reason: 'initial' | 'mention',
): boolean {
  if (!org.enabled) return false;
  if (org.enforced) {
    return !(org.mentionOnly && reason === 'initial');
  }
  if (owner?.enabled === false) return false;
  const mentionOnly = org.mentionOnly || owner?.mentionOnly === true;
  if (mentionOnly && reason === 'initial') return false;
  return true;
}

/** ORG code-review policy, read from GitHub service metadata. */
async function readCodeReviewOrgPolicy(appDb: AppDb): Promise<CodeReviewOrgPolicy> {
  const meta = await getGitHubMetadata(appDb) ?? {};
  return {
    enabled: meta.codeReviewEnabled !== false, // default true
    enforced: meta.codeReviewEnforced === true, // default false
    mentionOnly: meta.codeReviewMentionOnly === true, // default false
  };
}

/**
 * The repo owner's own preferences. Skipped when the org enforces — the owner
 * can only loosen within the org ceiling, so their row cannot change the result.
 */
async function readCodeReviewOwnerPrefs(
  appDb: AppDb,
  userId: string,
  orgEnforced: boolean,
): Promise<CodeReviewOwnerPrefs | null> {
  if (orgEnforced) return null;
  const row = await db.getUserById(appDb, userId);
  if (!row) return null;
  return { enabled: row.codeReviewEnabled ?? true, mentionOnly: row.codeReviewMentionOnly ?? false };
}

/** This App's bot handle, needed only to match an @-mention re-review request. */
async function resolveBotSlug(env: Env, appDb: AppDb, event: string): Promise<string | null> {
  if (event !== 'issue_comment') return null;
  const svc = await getServiceConfig<{ appSlug?: string }>(appDb, env.ENCRYPTION_KEY, 'github').catch(() => null);
  return svc?.config.appSlug ?? null;
}

/**
 * The code-review admission decision for one delivery on a repo-pinned webhook
 * trigger: the same repo check, author-trust check and org/owner policy the
 * GitHub App delivery path applies, so neither entry point is the soft one.
 */
async function gateCodeReviewDelivery(
  env: Env,
  appDb: AppDb,
  input: {
    event: string;
    payload: Record<string, unknown>;
    pinnedOwner: string;
    pinnedRepo: string;
    triggerUserId: string;
  },
): Promise<{ outcome: 'wrong_repo' } | { outcome: 'skip' } | { outcome: 'review'; decision: ReviewDecision }> {
  const repository = input.payload.repository as { name?: string; owner?: { login?: string } } | undefined;
  const deliveredOwner = repository?.owner?.login;
  const deliveredRepo = repository?.name;
  // A trigger armed for one repository must refuse a payload naming another —
  // the token is otherwise a universal read of any repo the App can reach.
  if (
    typeof deliveredOwner !== 'string' ||
    typeof deliveredRepo !== 'string' ||
    deliveredOwner.toLowerCase() !== input.pinnedOwner.toLowerCase() ||
    deliveredRepo.toLowerCase() !== input.pinnedRepo.toLowerCase()
  ) {
    return { outcome: 'wrong_repo' };
  }

  const orgPolicy = await readCodeReviewOrgPolicy(appDb);
  if (!orgPolicy.enabled) return { outcome: 'skip' };

  const botSlug = await resolveBotSlug(env, appDb, input.event);
  const decision = decideReview(input.event, input.payload, botSlug);
  if (!decision) return { outcome: 'skip' };

  const ownerPrefs = await readCodeReviewOwnerPrefs(appDb, input.triggerUserId, orgPolicy.enforced);
  if (!resolveCodeReviewGate(orgPolicy, ownerPrefs, decision.reason)) return { outcome: 'skip' };

  return { outcome: 'review', decision };
}

/**
 * Fan a GitHub App event out to every matching `github-app` trigger, gated by
 * decideReview + the org/owner code-review policy. Best-effort: one trigger
 * failure never blocks the webhook 200.
 */
export async function dispatchGithubAppReviews(
  env: Env,
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const appDb = getDb(env.DB);

  // ORG CEILING — read once, up front. An org master-switch OFF is absolute:
  // no per-owner setting can turn review back on, so short-circuit before any
  // further work (analog: an admin `deny` in resolveEffectiveActionPolicy).
  const orgPolicy = await readCodeReviewOrgPolicy(appDb);
  if (!orgPolicy.enabled) return;

  // Resolve the App's own slug so an @-mention re-review matches THIS bot's
  // handle (`@<slug>` / `@<slug>[bot]`), not the generic word "valet". Only
  // needed for issue_comment; skip the config read for pull_request events.
  const botSlug = await resolveBotSlug(env, appDb, event);

  const decision = decideReview(event, payload, botSlug);
  if (!decision) return;
  const { owner, repo, pullNumber, reason } = decision;

  const triggers = await db.findGithubAppTriggersForRepo(env.DB, owner, repo);
  if (triggers.length === 0) return;

  for (const trigger of triggers) {
    try {
      const config = JSON.parse(trigger.config) as { events?: string[]; rateLimit?: number };
      // Only fire triggers subscribed to this GitHub event.
      if (config.events && !config.events.includes(event)) continue;

      // PER-OWNER LOOSENING PASS. trigger.user_id is the person who ARMED this
      // automation on the repo (the owner), not the PR author. They may only
      // make review quieter for their own repos, never override the org.
      const ownerPrefs = await readCodeReviewOwnerPrefs(appDb, trigger.user_id, orgPolicy.enforced);
      if (!resolveCodeReviewGate(orgPolicy, ownerPrefs, reason)) continue;

      // Same per-trigger ceiling the generic webhook path enforces. An App
      // delivery is no cheaper than a manual one — each dispatch is an LLM run —
      // so a burst of events on one repo must not bypass the limit.
      const rate = await checkWebhookRateLimit(env, trigger.id, config);
      if (!rate.allowed) {
        console.warn(`[github-app dispatch] trigger ${trigger.id} rate limited (${rate.count}/${rate.limit} per 60s)`);
        continue;
      }

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
