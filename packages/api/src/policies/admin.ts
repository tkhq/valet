/**
 * CRUD/read service layer backing the policy admin routes (action-policies
 * plan, Task 4). Distinct from `service.ts` (host wiring for the RESOLUTION
 * path — grant writes, always-allow upsert, audit sink) — this module owns
 * the admin-facing surface: `action_policies` CRUD, per-user override
 * upsert/delete, "my grants" listing/revoke, and the action-log keyset
 * pagination query. Route handlers (`routes/policies.ts`,
 * `routes/me-policies.ts`) stay thin wrappers over these functions, matching
 * the `services/llm-providers.ts` / `routes/llm-providers.ts` split.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { ApprovalMode, RiskLevel } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import {
  actionInvocations,
  actionPolicies,
  actionPolicyOverrides,
  runtimeGrants,
  type ActionInvocationRow,
  type ActionPolicyOverrideRow,
  type ActionPolicyRow,
  type RuntimeGrantRow,
} from "../schema/index.js";
import { validateParamMatchers, type ParamMatcher } from "./matchers.js";
import { grantPolicyKey } from "./resolution.js";

/** One-of-three target shape shared by `action_policies` and
 *  `action_policy_overrides` — mirrors the DB CHECK constraint. */
export interface PolicyTarget {
  service?: string;
  actionId?: string;
  riskLevel?: RiskLevel;
}

export type TargetValidation = { ok: true } | { ok: false; error: string };

/** Validates the "exactly one of service/actionId/riskLevel" shape client-side,
 *  matching the DB CHECK constraint (`action_policies_one_of_target` /
 *  `action_policy_overrides_one_of_target`) — a route surfaces this as a 400
 *  before ever reaching the DB. */
export function validateTarget(target: PolicyTarget): TargetValidation {
  const count = [target.service, target.actionId, target.riskLevel].filter((v) => v !== undefined).length;
  if (count !== 1) {
    return { ok: false, error: "exactly one of service, actionId, riskLevel is required" };
  }
  return { ok: true };
}

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
export function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

const APPROVAL_MODES: readonly ApprovalMode[] = ["allow", "require_approval", "deny"];
export function isApprovalMode(v: unknown): v is ApprovalMode {
  return typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v);
}

/** Builds the equality predicate for `action_policies`' target dimension
 *  against a `PolicyTarget` — used by the org-policy bounds check below.
 *  Requires `target` to already have passed `validateTarget`. */
function policyTargetEquals(target: PolicyTarget) {
  if (target.service !== undefined) {
    return and(
      eq(actionPolicies.service, target.service),
      isNull(actionPolicies.actionId),
      isNull(actionPolicies.riskLevel),
    );
  }
  if (target.actionId !== undefined) {
    return and(
      isNull(actionPolicies.service),
      eq(actionPolicies.actionId, target.actionId),
      isNull(actionPolicies.riskLevel),
    );
  }
  if (target.riskLevel !== undefined) {
    return and(
      isNull(actionPolicies.service),
      isNull(actionPolicies.actionId),
      eq(actionPolicies.riskLevel, target.riskLevel),
    );
  }
  // Unreachable when `target` already passed `validateTarget` — every call
  // site validates first. Defensive fallback rather than a type assertion.
  throw new Error("target must have exactly one of service, actionId, riskLevel set");
}

/** Same shape as `policyTargetEquals`, over `action_policy_overrides` — used
 *  by the override upsert/delete-by-target paths. */
function overrideTargetEquals(target: PolicyTarget) {
  if (target.service !== undefined) {
    return and(
      eq(actionPolicyOverrides.service, target.service),
      isNull(actionPolicyOverrides.actionId),
      isNull(actionPolicyOverrides.riskLevel),
    );
  }
  if (target.actionId !== undefined) {
    return and(
      isNull(actionPolicyOverrides.service),
      eq(actionPolicyOverrides.actionId, target.actionId),
      isNull(actionPolicyOverrides.riskLevel),
    );
  }
  if (target.riskLevel !== undefined) {
    return and(
      isNull(actionPolicyOverrides.service),
      isNull(actionPolicyOverrides.actionId),
      eq(actionPolicyOverrides.riskLevel, target.riskLevel),
    );
  }
  throw new Error("target must have exactly one of service, actionId, riskLevel set");
}

// ── action_policies CRUD ────────────────────────────────────────────

/** Live (non-revoked) org policies, newest first. Revoked rows are DELETE's
 *  effect (soft-delete), so the default list excludes them — matching every
 *  other "list" route in this codebase reading past a soft-delete flag. */
export async function listOrgPolicies(db: AppDb, orgId: string): Promise<ActionPolicyRow[]> {
  return db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.orgId, orgId), isNull(actionPolicies.revokedAt)))
    .orderBy(desc(actionPolicies.createdAt));
}

export interface CreateOrgPolicyInput extends PolicyTarget {
  mode: ApprovalMode;
  paramMatchers?: ParamMatcher[];
  appliesIn?: "any" | "workflow" | "session";
  expiresAt?: number | null;
  managedBy: string;
  now: number;
}

export async function createOrgPolicy(db: AppDb, orgId: string, input: CreateOrgPolicyInput): Promise<ActionPolicyRow> {
  const row = {
    id: randomUUID(),
    orgId,
    principalType: "org" as const,
    principalId: orgId,
    service: input.service ?? null,
    actionId: input.actionId ?? null,
    riskLevel: input.riskLevel ?? null,
    mode: input.mode,
    paramMatchers: input.paramMatchers ?? [],
    appliesIn: input.appliesIn ?? "any",
    origin: "admin" as const,
    managedBy: input.managedBy,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const [inserted] = await db.insert(actionPolicies).values(row).returning();
  return inserted;
}

export interface UpdateOrgPolicyInput {
  mode?: ApprovalMode;
  paramMatchers?: ParamMatcher[];
  appliesIn?: "any" | "workflow" | "session";
  expiresAt?: number | null;
  now: number;
}

/** Updates the RULE fields only — `service`/`actionId`/`riskLevel` (the row's
 *  identity/target) are immutable after creation. Changing what a policy
 *  targets is modeled as delete-and-recreate, not an in-place target swap —
 *  keeps this update path from having to re-validate the one-of shape against
 *  a partial patch. Returns `undefined` when the row doesn't exist, is
 *  already revoked, or belongs to another org (cross-org 404, not 403 — this
 *  route never distinguishes "not found" from "not yours"). */
export async function updateOrgPolicy(
  db: AppDb,
  orgId: string,
  id: string,
  patch: UpdateOrgPolicyInput,
): Promise<ActionPolicyRow | undefined> {
  const set: Partial<typeof actionPolicies.$inferInsert> = { updatedAt: patch.now };
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.paramMatchers !== undefined) set.paramMatchers = patch.paramMatchers;
  if (patch.appliesIn !== undefined) set.appliesIn = patch.appliesIn;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;

  const [updated] = await db
    .update(actionPolicies)
    .set(set)
    .where(and(eq(actionPolicies.id, id), eq(actionPolicies.orgId, orgId), isNull(actionPolicies.revokedAt)))
    .returning();
  return updated;
}

/** Soft-revoke (DELETE = `revokedAt` stamp, never a row delete — same
 *  convention as `runtime_grants`). Idempotent: revoking an already-revoked
 *  row is a no-op that still returns the row (not a 404) so a retried DELETE
 *  reads as success, not "gone". */
export async function revokeOrgPolicy(db: AppDb, orgId: string, id: string, now: number): Promise<ActionPolicyRow | undefined> {
  const existing = await db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.id, id), eq(actionPolicies.orgId, orgId)))
    .limit(1);
  const row = existing[0];
  if (!row) return undefined;
  if (row.revokedAt !== null) return row;
  const [updated] = await db
    .update(actionPolicies)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(actionPolicies.id, id), eq(actionPolicies.orgId, orgId)))
    .returning();
  return updated;
}

// ── Override write-time bounds (spec decision 3) ────────────────────

/**
 * Conservative "what would the org policy alone decide for this exact
 * target" read — used ONLY to bound an override write, not real invocation
 * resolution (see `resolution.ts` for the real precedence core, which also
 * consults param matchers, `appliesIn`, and specificity across DIFFERENT
 * target dimensions).
 *
 * Deliberately narrower than full resolution: it only looks at org policies
 * matching the SAME target dimension as the override being written (e.g. an
 * actionId-scoped override is checked only against actionId-scoped org
 * policies, not a broader service- or risk-level-scoped one that would also
 * apply to that action at real invocation time). Widening this to the full
 * cross-dimension specificity walk needs the plugin catalog (to know an
 * action's service/riskLevel) and is out of scope here — documented as a
 * known gap, not a silent one.
 *
 * When multiple org policies match the same dimension (shouldn't normally
 * happen, but isn't prevented at the DB level), the most RESTRICTIVE wins:
 * any `deny` beats any `require_approval` beats plain `allow`. `undefined`
 * means no matching org policy — nothing to bound the override against.
 */
export async function orgPolicyModeForExactTarget(
  db: AppDb,
  orgId: string,
  target: PolicyTarget,
  now: number,
): Promise<ApprovalMode | undefined> {
  const rows = await db
    .select({ mode: actionPolicies.mode })
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.principalType, "org"),
        isNull(actionPolicies.revokedAt),
        or(isNull(actionPolicies.expiresAt), sql`${actionPolicies.expiresAt} > ${now}`),
        policyTargetEquals(target),
      ),
    );
  if (rows.some((r) => r.mode === "deny")) return "deny";
  if (rows.some((r) => r.mode === "require_approval")) return "require_approval";
  if (rows.length > 0) return "allow";
  return undefined;
}

/**
 * Enforces spec decision 3: a per-user override may only LOOSEN to `allow`
 * where the org's own policy for that exact target is `allow` or unset.
 * Tightening (`require_approval`/`deny`) is never restricted — a user can
 * always self-restrict further than the org allows.
 *
 * TOCTOU disclosure: this reads `action_policies` fresh but not inside the
 * same transaction as the override insert/update below, so a concurrent
 * admin write between this check and the write below is possible in
 * principle. Accepted, not fixed, for two reasons: (1) the real resolution
 * path (`resolution.ts`) re-derives the decision from live rows on EVERY
 * invocation — it never trusts this write-time check — so a stale
 * assessment here doesn't grant a stale outcome for lingering invocations,
 * (2) the actual security-relevant case (org `require_approval` +
 * override `allow`) resolves correctly at invocation time regardless of the
 * race, because rung ordering only lets an override outrank an org
 * `require_approval`, never an org `deny` (deny short-circuits at rung 0
 * before override is even consulted) — so the worst outcome of losing this
 * race is a transient window where a bypass override exists that a
 * subsequent admin `deny` will immediately re-supersede on the next
 * invocation, not a permanent hole.
 */
export async function validateOverrideBounds(
  db: AppDb,
  orgId: string,
  target: PolicyTarget,
  mode: ApprovalMode,
  now: number,
): Promise<TargetValidation> {
  if (mode !== "allow") return { ok: true };
  const orgMode = await orgPolicyModeForExactTarget(db, orgId, target, now);
  if (orgMode === "deny" || orgMode === "require_approval") {
    return {
      ok: false,
      error: `cannot set override mode "allow": org policy for this target currently resolves "${orgMode}"`,
    };
  }
  return { ok: true };
}

// ── action_policy_overrides upsert/delete-by-target ─────────────────

export interface UpsertOverrideInput extends PolicyTarget {
  mode: ApprovalMode;
  paramMatchers?: ParamMatcher[];
  now: number;
}

export type UpsertOverrideResult = { ok: true; row: ActionPolicyOverrideRow } | { ok: false; error: string };

/** Upsert-by-target (not by row id — see `routes/me-policies.ts` doc comment
 *  for why): finds the caller's existing override for this exact
 *  (org, user, target) triple and updates it in place, or inserts a fresh
 *  row. Enforces `validateOverrideBounds` before either path. */
export async function upsertOverride(
  db: AppDb,
  orgId: string,
  userId: string,
  input: UpsertOverrideInput,
): Promise<UpsertOverrideResult> {
  const targetCheck = validateTarget(input);
  if (!targetCheck.ok) return targetCheck;

  const boundsCheck = await validateOverrideBounds(db, orgId, input, input.mode, input.now);
  if (!boundsCheck.ok) return boundsCheck;

  const existing = await db
    .select()
    .from(actionPolicyOverrides)
    .where(and(eq(actionPolicyOverrides.orgId, orgId), eq(actionPolicyOverrides.userId, userId), overrideTargetEquals(input)))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(actionPolicyOverrides)
      .set({ mode: input.mode, paramMatchers: input.paramMatchers ?? [], updatedAt: input.now })
      .where(eq(actionPolicyOverrides.id, existing[0].id))
      .returning();
    return { ok: true, row: updated };
  }

  const [inserted] = await db
    .insert(actionPolicyOverrides)
    .values({
      id: randomUUID(),
      orgId,
      userId,
      service: input.service ?? null,
      actionId: input.actionId ?? null,
      riskLevel: input.riskLevel ?? null,
      mode: input.mode,
      paramMatchers: input.paramMatchers ?? [],
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return { ok: true, row: inserted };
}

export async function listMyOverrides(db: AppDb, orgId: string, userId: string): Promise<ActionPolicyOverrideRow[]> {
  return db
    .select()
    .from(actionPolicyOverrides)
    .where(and(eq(actionPolicyOverrides.orgId, orgId), eq(actionPolicyOverrides.userId, userId)))
    .orderBy(desc(actionPolicyOverrides.createdAt));
}

/** Hard-delete by exact target (overrides have no `revokedAt` column — unlike
 *  `action_policies`/`runtime_grants`, there's no audit reason to keep a
 *  tombstone for a user's own preference row). Returns `false` when no
 *  matching row exists (caller 404s). */
export async function deleteOverrideByTarget(db: AppDb, orgId: string, userId: string, target: PolicyTarget): Promise<boolean> {
  const targetCheck = validateTarget(target);
  if (!targetCheck.ok) return false;
  const deleted = await db
    .delete(actionPolicyOverrides)
    .where(and(eq(actionPolicyOverrides.orgId, orgId), eq(actionPolicyOverrides.userId, userId), overrideTargetEquals(target)))
    .returning({ id: actionPolicyOverrides.id });
  return deleted.length > 0;
}

// ── runtime_grants: "my grants" list + revoke-by-target ─────────────

export async function listMyGrants(db: AppDb, orgId: string, grantedBy: string): Promise<RuntimeGrantRow[]> {
  return db
    .select()
    .from(runtimeGrants)
    .where(and(eq(runtimeGrants.orgId, orgId), eq(runtimeGrants.grantedBy, grantedBy), isNull(runtimeGrants.revokedAt)))
    .orderBy(desc(runtimeGrants.createdAt));
}

export interface RevokeGrantTarget {
  sessionId?: string;
  workflowExecutionId?: string;
  service: string;
  actionId: string;
}

/** Soft-revoke (stamp `revokedAt`, never row-delete — spec decision, see
 *  `service.ts`'s `revokeSessionGrants`/`revokeExecutionGrants`). Scoped to
 *  grants the caller themselves minted (`grantedBy = userId`) — "my grants"
 *  is a caller's own approval history, not a general admin grant browser.
 *  Returns `false` when no matching LIVE grant exists. */
export async function revokeMyGrant(
  db: AppDb,
  orgId: string,
  grantedBy: string,
  target: RevokeGrantTarget,
  now: number,
): Promise<boolean> {
  const scope =
    target.sessionId !== undefined
      ? eq(runtimeGrants.sessionId, target.sessionId)
      : target.workflowExecutionId !== undefined
        ? eq(runtimeGrants.workflowExecutionId, target.workflowExecutionId)
        : undefined;
  if (!scope) return false;

  const updated = await db
    .update(runtimeGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(runtimeGrants.orgId, orgId),
        eq(runtimeGrants.grantedBy, grantedBy),
        isNull(runtimeGrants.revokedAt),
        scope,
        eq(runtimeGrants.policyKey, grantPolicyKey(target.service, target.actionId)),
      ),
    )
    .returning({ id: runtimeGrants.id });
  return updated.length > 0;
}

// ── action_invocations: keyset-paginated action log ──────────────────

/** Opaque cursor payload: `s` = `coalesce(started_at, 0)` at the last row of
 *  the previous page, `id` = that row's `invocationId` (tiebreaker for rows
 *  sharing the same `s`). Both are part of the sort key, so the pair is a
 *  stable resume point even under concurrent inserts — a row inserted after
 *  the first page was read either sorts before the cursor (invisible, same
 *  as before it existed) or after it (visible on a later page), never
 *  duplicated or skipped within the paginated range already returned. */
export interface ActionLogCursor {
  s: number;
  id: string;
}

export function encodeActionLogCursor(cursor: ActionLogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns `undefined` for a malformed cursor — callers 400 rather than
 *  silently falling back to page 1 (a client retrying with a corrupted
 *  cursor should see an error, not skip data unknowingly). */
export function decodeActionLogCursor(raw: string): ActionLogCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.s !== "number" || typeof rec.id !== "string") return undefined;
    return { s: rec.s, id: rec.id };
  } catch {
    return undefined;
  }
}

export interface ActionLogFilters {
  service?: string;
  userId?: string;
  resolvedMode?: ApprovalMode;
  status?: NonNullable<ActionInvocationRow["status"]>;
  /** Inclusive epoch-ms bounds on `startedAt`. A row with a null `startedAt`
   *  never matches a `from`/`to` filter (SQL `NULL >= x` is unknown, not
   *  true) — rows never explicitly started (e.g. denied before dispatch)
   *  are excluded from a time-bounded query, not surfaced at an arbitrary
   *  edge of the range. */
  from?: number;
  to?: number;
}

export const ACTION_LOG_DEFAULT_LIMIT = 50;
export const ACTION_LOG_MAX_LIMIT = 100;

export interface ActionLogPage {
  rows: ActionInvocationRow[];
  nextCursor: string | undefined;
}

/**
 * Keyset pagination on `(coalesce(started_at, 0) DESC, invocation_id DESC)`
 * — the first cursor-paginated route in this codebase. Keyset (not
 * offset/limit) so pages stay stable under concurrent inserts: a row
 * inserted ahead of the cursor after page 1 was read never re-shifts
 * page 2's contents, unlike `OFFSET N` which would skip or repeat rows.
 * `invocationId` breaks ties within the same `startedAt` millisecond
 * deterministically (`startedAt` alone is not unique enough under load).
 *
 * `limit+1` is fetched to detect "more pages exist" without a second
 * COUNT query; the (limit+1)th row (if present) is trimmed off and its
 * key becomes `nextCursor`.
 */
export async function listActionLog(db: AppDb, orgId: string, filters: ActionLogFilters, limit: number, cursor: ActionLogCursor | undefined): Promise<ActionLogPage> {
  const conditions = [eq(actionInvocations.orgId, orgId)];
  if (filters.service !== undefined) conditions.push(eq(actionInvocations.service, filters.service));
  if (filters.userId !== undefined) conditions.push(eq(actionInvocations.userId, filters.userId));
  if (filters.resolvedMode !== undefined) conditions.push(eq(actionInvocations.resolvedMode, filters.resolvedMode));
  if (filters.status !== undefined) conditions.push(eq(actionInvocations.status, filters.status));
  if (filters.from !== undefined) conditions.push(sql`${actionInvocations.startedAt} >= ${filters.from}`);
  if (filters.to !== undefined) conditions.push(sql`${actionInvocations.startedAt} <= ${filters.to}`);
  if (cursor) {
    conditions.push(
      sql`(coalesce(${actionInvocations.startedAt}, 0), ${actionInvocations.invocationId}) < (${cursor.s}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(...conditions))
    .orderBy(sql`coalesce(${actionInvocations.startedAt}, 0) desc`, desc(actionInvocations.invocationId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeActionLogCursor({ s: last.startedAt ?? 0, id: last.invocationId }) : undefined;

  return { rows: page, nextCursor };
}
