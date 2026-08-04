/**
 * Arbitrary-URL webhook triggers (overhaul design decision 5,
 * docs/specs/2026-07-16-workflows-overhaul-design.md): one opaque bearer
 * secret per workflow, minted into `POST /api/hooks/workflows/:workflowId/
 * :hookId`. The hookId IS the credential — matching webhook convention,
 * that route is intentionally unauthenticated (see `routes/workflow-
 * hooks.ts`), so `resolveWebhookTarget` is constant-time and every one of
 * ITS failure modes (unknown workflow, wrong hookId, deleted workflow)
 * returns the SAME `null` — never let the public route's caller distinguish
 * "workflow doesn't exist" from "hookId is wrong", that's an enumeration
 * oracle. The OWNER-scoped management functions below it are a different
 * trust boundary (the caller already authenticated as the workflow's
 * owner) and DO distinguish "not found" from "found but empty" — collapsing
 * those would just be a worse error message for an already-authenticated
 * caller, not a security property.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowWebhooks } from "../schema/index.js";
import { newWorkflowId, ownedDefinitionRow, type WorkflowOwner } from "./service.js";

export interface WorkflowWebhookSummary {
  workflowId: string;
  hookId: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowWebhookTarget {
  workflowId: string;
  definition: unknown;
  ownerType: string;
  ownerId: string;
}

function newHookId(): string {
  return randomBytes(32).toString("hex");
}

function rowToSummary(row: typeof workflowWebhooks.$inferSelect): WorkflowWebhookSummary {
  return {
    workflowId: row.workflowId,
    hookId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Mints a new hookId for `workflowId`, replacing any existing one (the
 * old URL stops working immediately — this is the "regenerable" half of
 * decision 5). Ownership-checked like every other workflow mutation.
 *
 * A single `INSERT ... ON CONFLICT (workflow_id) DO UPDATE` rather than a
 * select-then-branch: two concurrent mints for the same workflow (a
 * double-clicked "regenerate" button, or two racing agent-tool calls)
 * would otherwise both observe "no existing row" and both attempt an
 * insert, and the second would throw on the `workflow_webhooks_workflow`
 * unique index. Postgres resolves the conflict atomically; exactly one
 * hookId wins and the loser's insert becomes that same update. */
export async function mintOrRotateWorkflowWebhook(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId: string,
  now = Date.now(),
): Promise<{ ok: true; webhook: WorkflowWebhookSummary } | { ok: false; error: string }> {
  const def = await ownedDefinitionRow(db, owner, workflowId);
  if (!def) return { ok: false, error: `workflow not found: ${workflowId}` };

  const hookId = newHookId();
  const rows = await db
    .insert(workflowWebhooks)
    .values({ id: hookId, workflowId, orgId: owner.orgId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workflowWebhooks.workflowId,
      set: { id: hookId, updatedAt: now },
    })
    .returning();
  return { ok: true, webhook: rowToSummary(rows[0]!) };
}

/** Current hook status for the editor/agent-tool surface. `ok:false` means
 * the workflow itself is missing or not owned by the caller; `ok:true`
 * with `webhook: null` means the workflow is real but has no hook yet —
 * these are different states for an already-authenticated caller and the
 * route layer reports them differently (404 vs 200-with-null). */
export async function getWorkflowWebhook(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<{ ok: true; webhook: WorkflowWebhookSummary | null } | { ok: false; error: string }> {
  const def = await ownedDefinitionRow(db, owner, workflowId);
  if (!def) return { ok: false, error: `workflow not found: ${workflowId}` };

  const rows = await db.select().from(workflowWebhooks).where(eq(workflowWebhooks.workflowId, workflowId)).limit(1);
  return { ok: true, webhook: rows[0] ? rowToSummary(rows[0]) : null };
}

export type DeleteWorkflowWebhookResult = "deleted" | "not_configured" | "not_found";

/** Deletes the hook, if any. Three-way result (mirrors
 * `deleteWorkflowSchedule`'s `"ok" | "not_found"` shape, extended by one
 * state): `not_found` is the workflow itself being missing/unowned,
 * `not_configured` is an owned workflow with no hook to delete. */
export async function deleteWorkflowWebhook(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<DeleteWorkflowWebhookResult> {
  const def = await ownedDefinitionRow(db, owner, workflowId);
  if (!def) return "not_found";

  const deleted = await db
    .delete(workflowWebhooks)
    .where(eq(workflowWebhooks.workflowId, workflowId))
    .returning({ id: workflowWebhooks.id });
  return deleted.length > 0 ? "deleted" : "not_configured";
}

/** The public ingress route's ONLY entry point into this module. Fetches
 * the hook by `workflowId`, then compares `candidateHookId` in constant
 * time (same pattern as `lib/internal-auth.ts#isValidInternalToken`) —
 * length mismatch short-circuits false without touching `timingSafeEqual`
 * (which requires equal-length buffers and otherwise throws), which is
 * safe because hookIds are always the same fixed length. Every failure
 * path — unknown workflow, no hook minted, wrong hookId, workflow deleted
 * out from under a still-live hook — returns `null` uniformly so the
 * route's 404 never becomes an oracle. */
export async function resolveWebhookTarget(
  db: AppDb,
  workflowId: string,
  candidateHookId: string,
): Promise<WorkflowWebhookTarget | null> {
  const hookRows = await db.select().from(workflowWebhooks).where(eq(workflowWebhooks.workflowId, workflowId)).limit(1);
  const hook = hookRows[0];
  if (!hook) return null;

  const expected = Buffer.from(hook.id, "utf8");
  const candidate = Buffer.from(candidateHookId, "utf8");
  if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) return null;

  const defRows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId)).limit(1);
  const def = defRows[0];
  if (!def) return null;

  return { workflowId, definition: def.definition, ownerType: def.ownerType, ownerId: def.ownerId };
}

/**
 * Deterministic when `idempotencyKey` is supplied (an `Idempotency-Key`
 * header from the caller), scoped per-workflow so the same key from two
 * different integrations targeting different workflows can't collide.
 * `WorkflowStore.createRun` is insert-if-absent (`store.ts`), so a
 * webhook-provider retry that resends the same key becomes a no-op against
 * the already-started run instead of a duplicate — the same protection
 * `EventDispatcher` gets from `wfrun_evt_${deliveryId}` and the scheduler
 * gets from `scheduledRunId`. Falls back to a fresh random id when no key
 * is supplied, matching a manual/one-off trigger's expectation that every
 * POST starts its own run. */
export function deriveWebhookRunId(workflowId: string, idempotencyKey?: string): string {
  if (!idempotencyKey) return newWorkflowId("wfrun");
  const digest = createHash("sha256").update(`${workflowId}:${idempotencyKey}`).digest("hex");
  return `wfrun_hook_${digest.slice(0, 20)}`;
}

export interface WorkflowWebhookRateLimiterOptions {
  /** Max requests admitted per workflow within `windowMs`. */
  limit: number;
  windowMs: number;
  /** Caps the number of distinct `workflowId` keys tracked at once — the
   * limiter's `workflowId` key comes straight from an unauthenticated
   * caller's URL path, so without a cap an attacker can grow the Map
   * without bound by varying it (every value gets its own entry, written
   * on both the admit AND reject branch). Least-recently-touched key is
   * evicted when the cap is exceeded. Default chosen generously above any
   * realistic legitimate workflow count for a single deployment. */
  maxTrackedKeys?: number;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

/** In-memory, per-workflow, fixed-size-window limiter — "coarse" per
 * decision 5. Not shared across API instances; a single-process concern
 * matching the LocalRunHost's own single-process scope. */
export class WorkflowWebhookRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxTrackedKeys: number;

  constructor(private readonly opts: WorkflowWebhookRateLimiterOptions) {
    this.maxTrackedKeys = opts.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  /** Records and admits a hit for `workflowId` at `now`, or rejects if the
   * workflow is already at its limit within the trailing window. */
  allow(workflowId: string, now: number): boolean {
    const cutoff = now - this.opts.windowMs;
    const fresh = (this.hits.get(workflowId) ?? []).filter((t) => t > cutoff);
    // Re-inserting moves the key to the end of Map's iteration order (JS
    // Maps preserve insertion order, and `delete`+`set` re-inserts at the
    // end), which is what makes "delete the first key" below an LRU evict
    // rather than an arbitrary one.
    this.hits.delete(workflowId);
    if (fresh.length >= this.opts.limit) {
      this.hits.set(workflowId, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(workflowId, fresh);
    if (this.hits.size > this.maxTrackedKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return true;
  }

  /** Number of distinct `workflowId`s currently tracked — bounded by
   * `maxTrackedKeys`. Exposed for operational introspection/metrics as
   * much as for tests. */
  trackedKeyCount(): number {
    return this.hits.size;
  }
}
