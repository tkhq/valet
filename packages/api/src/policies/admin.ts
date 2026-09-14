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
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import {
  ACTION_POLICY_AUTHORIZATION_KIND, agentSessions, workflowRuns, workflowDefinitions,
  actionInvocations,
  actionPolicies,
  actionPolicyOverrides,
  runtimeGrants,
  type ActionInvocationRow,
  type ActionPolicyOverrideRow,
  type ActionPolicyRow,
  type RuntimeGrantRow,
} from "../schema/index.js";
import { type ParamMatcher } from "./matchers.js";


/** One-of-three target shape shared by `action_policies` and
 *  `action_policy_overrides` — mirrors the DB CHECK constraint. */
export interface PolicyTarget {
  authorizationKind?: "tool.action" | "tool.builtin";
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

/** Same shape as the retired `policyTargetEquals`, over
 *  `action_policy_overrides` — used
 *  by the override upsert/delete-by-target paths. */
function overrideTargetEquals(target: PolicyTarget) {
  const kind = eq(actionPolicyOverrides.authorizationKind, target.authorizationKind ?? "tool.action");
  if (target.service !== undefined) {
    return and(
      kind
      eq(actionPolicyOverrides.service, target.service),
      isNull(actionPolicyOverrides.actionId),
      isNull(actionPolicyOverrides.riskLevel),
    );
  }
  if (target.actionId !== undefined) {
    return and(
      kind
      isNull(actionPolicyOverrides.service),
      eq(actionPolicyOverrides.actionId, target.actionId),
      isNull(actionPolicyOverrides.riskLevel),
    );
  }
  if (target.riskLevel !== undefined) {
    return and(
      kind
      isNull(actionPolicyOverrides.service),
      isNull(actionPolicyOverrides.actionId),
      eq(actionPolicyOverrides.riskLevel, target.riskLevel),
    );
  }
  throw new Error("target must have exactly one of service, actionId, riskLevel set");
}

export interface PolicyScope { orgId: string; type: "org" | "team"; id: string }

function policyScopeFilter(scope: PolicyScope) {
  return and(eq(actionPolicies.authorizationKind, ACTION_POLICY_AUTHORIZATION_KIND), eq(actionPolicies.orgId, scope.orgId), eq(actionPolicies.principalType, scope.type), eq(actionPolicies.principalId, scope.id));
}

// ── action_policies CRUD ────────────────────────────────────────────

/** Live (non-revoked) org policies, newest first. Revoked rows are DELETE's
 *  effect (soft-delete), so the default list excludes them — matching every
 *  other "list" route in this codebase reading past a soft-delete flag. */
export async function listPolicies(db: AppQueryable, scope: PolicyScope): Promise<ActionPolicyRow[]> {
  return db
    .select()
    .from(actionPolicies)
    .where(and(policyScopeFilter(scope), isNull(actionPolicies.revokedAt)))
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

export async function createPolicy(db: AppQueryable, scope: PolicyScope, input: CreateOrgPolicyInput): Promise<ActionPolicyRow> {
  const row = {
    id: randomUUID(),
    orgId: scope.orgId,
    authorizationKind: ACTION_POLICY_AUTHORIZATION_KIND,
    principalType: scope.type,
    principalId: scope.id,
    authorizationKind: input.authorizationKind ?? "tool.action",
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
export async function updatePolicy(
  db: AppQueryable,
  scope: PolicyScope,
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
    .where(and(eq(actionPolicies.id, id), policyScopeFilter(scope), isNull(actionPolicies.revokedAt)))
    .returning();
  return updated;
}

/** Soft-revoke (DELETE = `revokedAt` stamp, never a row delete — same
 *  convention as `runtime_grants`). Idempotent: revoking an already-revoked
 *  row is a no-op that still returns the row (not a 404) so a retried DELETE
 *  reads as success, not "gone". */
export async function revokePolicy(db: AppQueryable, scope: PolicyScope, id: string, now: number): Promise<ActionPolicyRow | undefined> {
  const existing = await db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.id, id), policyScopeFilter(scope)))
    .limit(1);
  const row = existing[0];
  if (!row) return undefined;
  if (row.revokedAt !== null) return row;
  const [updated] = await db
    .update(actionPolicies)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(actionPolicies.id, id), policyScopeFilter(scope)))
    .returning();
  return updated;
}

export const listOrgPolicies = (db: AppDb, orgId: string) => listPolicies(db, { orgId, type: "org", id: orgId });

export interface UpsertOverrideInput extends PolicyTarget {
  mode: ApprovalMode;
  paramMatchers?: ParamMatcher[];
  now: number;
}

export type UpsertOverrideResult = { ok: true; row: ActionPolicyOverrideRow } | { ok: false; error: string };

/** Upsert-by-target (not by row id — see `routes/me-policies.ts` doc comment
 *  for why): finds the caller's existing override for this exact
 *  (org, user, target) triple and updates it in place, or inserts a fresh
 *  row. The caller must enforce canonical override bounds first. */
export async function upsertOverride(
  db: AppQueryable,
  orgId: string,
  userId: string,
  input: UpsertOverrideInput,
): Promise<UpsertOverrideResult> {
  const targetCheck = validateTarget(input);
  if (!targetCheck.ok) return targetCheck;

  const existing = await db
    .select()
    .from(actionPolicyOverrides)
    .where(and(eq(actionPolicyOverrides.orgId, orgId), eq(actionPolicyOverrides.userId, userId), overrideTargetEquals(input)))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(actionPolicyOverrides)
      .set({ mode: input.mode, paramMatchers: input.paramMatchers ?? [], updatedAt: input.now })
      .where(and(eq(actionPolicyOverrides.id, existing[0].id), eq(actionPolicyOverrides.authorizationKind, ACTION_POLICY_AUTHORIZATION_KIND)))
      .returning();
    return { ok: true, row: updated };
  }

  const [inserted] = await db
    .insert(actionPolicyOverrides)
    .values({
      id: randomUUID(),
      orgId,
      authorizationKind: ACTION_POLICY_AUTHORIZATION_KIND,
      userId,
      authorizationKind: input.authorizationKind ?? "tool.action",
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
    .where(and(eq(actionPolicyOverrides.authorizationKind, ACTION_POLICY_AUTHORIZATION_KIND), eq(actionPolicyOverrides.orgId, orgId), eq(actionPolicyOverrides.userId, userId)))
    .orderBy(desc(actionPolicyOverrides.createdAt));
}

/** Hard-delete by exact target (overrides have no `revokedAt` column — unlike
 *  `action_policies`/`runtime_grants`, there's no audit reason to keep a
 *  tombstone for a user's own preference row). Returns `false` when no
 *  matching row exists (caller 404s). */
export async function deleteOverrideByTarget(db: AppQueryable, orgId: string, userId: string, target: PolicyTarget): Promise<boolean> {
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
        eq(runtimeGrants.policyKey, (target.actionId.startsWith(`${target.service}.`) ? target.actionId : `${target.service}.${target.actionId}`)),
      ),
    )
    .returning({ id: runtimeGrants.id });
  return updated.length > 0;
}

// ── action_invocations: keyset-paginated action log ──────────────────

/** Opaque cursor payload: `s` = `created_at` at the last row of the previous
 *  page, `id` = that row's `invocationId` (tiebreaker for rows sharing the
 *  same `created_at`). Both are part of the sort key, so the pair is a stable
 *  resume point even under concurrent inserts — a row inserted after the first
 *  page was read either sorts before the cursor (invisible, same as before it
 *  existed) or after it (visible on a later page), never duplicated or skipped
 *  within the paginated range already returned. `created_at` (not
 *  `started_at`) keys the sort so denied/rejected rows and workflow rows —
 *  all of which have a null `started_at` — interleave chronologically instead
 *  of collapsing to `coalesce(...,0)` at the tail (I3). */
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
  /** Inclusive epoch-ms bounds on `createdAt` (the row's emission time, always
   *  populated) — NOT `startedAt` (I3). Keying the window on `createdAt` keeps
   *  denied/rejected and workflow rows (null `startedAt`) inside a
   *  time-bounded query instead of silently dropping them: SQL `NULL >= x` is
   *  unknown, so a `startedAt`-keyed `from`/`to` excluded every never-started
   *  row regardless of when it actually happened. */
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
 * Keyset pagination on `(created_at DESC, invocation_id DESC)` — the first
 * cursor-paginated route in this codebase. `created_at` (always populated),
 * NOT `coalesce(started_at, 0)` (I3): keying on `started_at` sank every
 * denied/rejected and workflow row (null `started_at`) to the tail and, via
 * `NULL >= x`, out of any `from`/`to` window — burying exactly the denials an
 * admin most wants to see. Keyset (not offset/limit) so pages stay stable
 * under concurrent inserts: a row inserted ahead of the cursor after page 1
 * was read never re-shifts page 2's contents, unlike `OFFSET N` which would
 * skip or repeat rows. `invocationId` breaks ties within the same `createdAt`
 * millisecond deterministically (`createdAt` alone is not unique under load).
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
  if (filters.from !== undefined) conditions.push(sql`${actionInvocations.createdAt} >= ${filters.from}`);
  if (filters.to !== undefined) conditions.push(sql`${actionInvocations.createdAt} <= ${filters.to}`);
  if (cursor) {
    conditions.push(
      sql`(${actionInvocations.createdAt}, ${actionInvocations.invocationId}) < (${cursor.s}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(...conditions))
    .orderBy(desc(actionInvocations.createdAt), desc(actionInvocations.invocationId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeActionLogCursor({ s: last.createdAt, id: last.invocationId }) : undefined;

  return { rows: page, nextCursor };
}

/** Caller holds the team's ownership/authority locks. Advanced rows never
 * participate: saving a simple preference must not clear their conditions. */
export async function upsertSimpleTeamPolicy(db: AppQueryable, scope: PolicyScope, input: CreateOrgPolicyInput) {
  const rows = await listPolicies(db, scope);
  const existing = rows.filter(row => row.appliesIn === "any" && row.paramMatchers.length === 0 && row.expiresAt === null
    && row.service === (input.service ?? null) && row.actionId === (input.actionId ?? null) && row.riskLevel === (input.riskLevel ?? null));
  if (!existing.length) return createPolicy(db, scope, input);
  // Historical duplicate simple rows are retired, never deleted. Advanced rows
  // sharing this target remain independent and retain all their fields.
  for (const duplicate of existing.slice(1)) await revokePolicy(db, scope, duplicate.id, input.now);
  return updatePolicy(db, scope, existing[0].id, { mode: input.mode, now: input.now });
}

function teamGrantOwner(orgId: string, teamId: string) {
  return and(eq(runtimeGrants.orgId, orgId), isNull(runtimeGrants.revokedAt), or(
    sql`exists (select 1 from ${agentSessions} where ${agentSessions.id} = ${runtimeGrants.sessionId}
      and ${agentSessions.orgId} = ${orgId} and ${agentSessions.ownerType} = 'team' and ${agentSessions.ownerId} = ${teamId})`,
    sql`exists (select 1 from ${workflowRuns} inner join ${workflowDefinitions} on ${workflowDefinitions.id} = ${workflowRuns.workflowId}
      where ${workflowRuns.id} = ${runtimeGrants.workflowExecutionId} and ${workflowDefinitions.orgId} = ${orgId}
      and ${workflowRuns.ownerType} = 'team' and ${workflowRuns.ownerId} = ${teamId})`,
  ));
}

export async function listTeamGrants(db: AppQueryable, orgId: string, teamId: string) {
  return db.select().from(runtimeGrants).where(teamGrantOwner(orgId, teamId)).orderBy(desc(runtimeGrants.createdAt));
}

export async function revokeTeamGrant(db: AppQueryable, orgId: string, teamId: string, id: string, now: number) {
  // Ownership is included in the mutation itself, not inferred from grantedBy.
  const rows = await db.update(runtimeGrants).set({ revokedAt: now })
    .where(and(eq(runtimeGrants.id, id), teamGrantOwner(orgId, teamId))).returning({ id: runtimeGrants.id });
  return rows.length > 0;
}
