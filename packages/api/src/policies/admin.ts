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
import type { ActionPlugin, ApprovalMode, RiskLevel, ValetPlugin } from "@valet/engine";
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
import { type ParamMatcher } from "./matchers.js";
import { grantPolicyKey, resolvePolicyDecision, type PolicyResolutionRows } from "./resolution.js";
import { loadPolicyRows } from "./service.js";

/** Service→plugin index shape `validateOverrideBounds` needs to look up an
 *  actionId's `service`/`riskLevel`/plugin default — same map shape as
 *  `Providers.actionPluginByService` (`providers/types.ts`). */
export type ActionPluginByService = Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;

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

/** Same shape as the retired `policyTargetEquals`, over
 *  `action_policy_overrides` — used
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

/** Minimal shape read off `action_policies` for the cross-dimension bounds
 *  walk below — every live, unexpired org policy, any target dimension. */
interface OrgPolicyDimensionRow {
  id: string;
  service: string | null;
  actionId: string | null;
  riskLevel: RiskLevel | null;
  mode: ApprovalMode;
}

async function loadLiveOrgPolicyDimensionRows(db: AppDb, orgId: string, now: number): Promise<OrgPolicyDimensionRow[]> {
  return db
    .select({
      id: actionPolicies.id,
      service: actionPolicies.service,
      actionId: actionPolicies.actionId,
      riskLevel: actionPolicies.riskLevel,
      mode: actionPolicies.mode,
    })
    .from(actionPolicies)
    .where(
      and(
        eq(actionPolicies.orgId, orgId),
        eq(actionPolicies.principalType, "org"),
        isNull(actionPolicies.revokedAt),
        or(isNull(actionPolicies.expiresAt), sql`${actionPolicies.expiresAt} > ${now}`),
      ),
    );
}

/** Looks up an actionId in the assembled plugin catalog (static `actions`
 *  list only — an action only reachable via a plugin's dynamic
 *  `resolveActions` seam is, by construction, unverifiable here and treated
 *  the same as "not found"). Returns the action's `service`/`riskLevel` plus
 *  its plugin's `defaultApprovalMode`, everything `resolveActionPolicy` needs
 *  to derive the same base decision (rungs 3-5) real invocation would. */
function findCatalogAction(
  actionPluginByService: ActionPluginByService,
  actionId: string,
): { service: string; riskLevel: RiskLevel; pluginDefault: ApprovalMode | undefined } | undefined {
  for (const { actionPlugin } of actionPluginByService.values()) {
    // Match raw `a.id` OR its fqid — the canonical policy-facing id is the
    // fully-qualified `service.action` form (spec T6 #3), but a plugin may
    // declare bare action ids.
    const action = actionPlugin.actions.find(
      (a) => a.id === actionId || (a.id.includes(".") ? a.id : `${actionPlugin.service}.${a.id}`) === actionId,
    );
    if (action) {
      return { service: actionPlugin.service, riskLevel: action.riskLevel, pluginDefault: actionPlugin.defaultApprovalMode };
    }
  }
  return undefined;
}

function blockedByOrgPolicy(row: OrgPolicyDimensionRow): TargetValidation {
  const label =
    row.actionId !== null ? `actionId="${row.actionId}"` : row.service !== null ? `service="${row.service}"` : `riskLevel="${row.riskLevel}"`;
  return {
    ok: false,
    error: `cannot set override mode "allow": conflicts with org policy (${label}, mode="${row.mode}"); ask an org admin`,
  };
}

/**
 * actionId-scoped override bound: resolves the exact action's FULL org-side
 * decision (every org-policy dimension — service/actionId/riskLevel — via
 * `resolveActionPolicy`, same precedence real invocation uses) with the
 * user's own overrides and any runtime grant EXCLUDED (`resolveActionPolicy`
 * is called with no `userId`/`sessionId`/`workflowExecutionId`, so
 * `loadPolicyRows` returns empty `grants`/`overrides` — org policy alone).
 * Blocks only when an ORG policy (not a plugin default or the engine's risk
 * default) resolves deny/require_approval — matching spec decision 3, which
 * bounds the override against the org's OWN policy, never against a mere
 * default. An actionId absent from the static plugin catalog fails CLOSED
 * (this also covers an action only reachable via a plugin's dynamic
 * `resolveActions` seam — intentional, same "unverifiable ⇒ refuse" logic,
 * not an oversight): with no way to know its real service/riskLevel, a
 * service- or riskLevel-scoped org policy could silently apply to it at
 * invocation time with nothing here to catch it.
 *
 * Matcher-blind resolution (finding C1): the bounds check resolves with
 * `params: undefined`, so an org policy carrying `paramMatchers` would
 * evaluate every matcher to false and silently drop out of precedence —
 * letting a member's `allow` override be accepted, then outrank that same
 * org `require_approval` at rung 2 whenever the params DID match at real
 * invocation. To close it, org policy rows are stripped of their
 * `paramMatchers` before resolution here ("a matcher MIGHT match" ⇒ treat
 * the row as matching). Full-precedence resolution is preserved, so a
 * genuinely more-specific org `allow` still legitimately unblocks the
 * override. This resolves the pure core directly (not `resolveActionPolicy`)
 * precisely so the row set can be transformed before precedence runs.
 *
 * Resolved TWICE, once per `appliesIn` context (`"session"` and
 * `"workflow"`), and blocked if EITHER resolves org deny/require_approval —
 * fix round 2 (Important). A per-user override carries no `appliesIn` of its
 * own (`matchesOverrideRow` never filters on it — see `resolution.ts`), so
 * it applies to BOTH session and workflow invocations, but an org policy's
 * `appliesIn` DOES filter which context it matches
 * (`action-invoker.ts` resolves workflow-side actions with
 * `appliesIn: "workflow"` and a real `userId`, so the override IS consulted
 * there too). Checking only `"session"` left an org policy scoped
 * `appliesIn: "workflow"` invisible to this bound while still being
 * outranked by the override at real workflow invocation time — the same
 * class of permanent bypass finding 1 closed for the target-dimension axis,
 * reopened one axis over.
 */
async function validateActionIdOverrideBounds(
  db: AppDb,
  orgId: string,
  actionId: string,
  now: number,
  actionPluginByService: ActionPluginByService,
): Promise<TargetValidation> {
  const found = findCatalogAction(actionPluginByService, actionId);
  if (!found) {
    return {
      ok: false,
      error: `cannot set override mode "allow": action "${actionId}" is not in the plugin catalog and can't be verified against org policy`,
    };
  }
  // Org policy alone: no userId/sessionId scope, so `loadPolicyRows` returns
  // empty grants/overrides. Strip `paramMatchers` so a matcher-scoped org
  // policy is treated as "might match" instead of silently dropping out when
  // we resolve with `params: undefined` (C1).
  const loaded = await loadPolicyRows(db, { orgId });
  const matcherBlind: PolicyResolutionRows = {
    ...loaded,
    policies: loaded.policies.map((p) => (p.paramMatchers.length > 0 ? { ...p, paramMatchers: [] } : p)),
  };
  for (const appliesIn of ["session", "workflow"] as const) {
    const decision = resolvePolicyDecision(
      matcherBlind,
      {
        service: found.service,
        actionId,
        riskLevel: found.riskLevel,
        params: undefined,
        appliesIn,
        now,
      },
      found.pluginDefault,
    );
    if (decision.provenance.source === "org_policy" && (decision.mode === "deny" || decision.mode === "require_approval")) {
      return {
        ok: false,
        error: `cannot set override mode "allow": org policy for action "${actionId}" currently resolves "${decision.mode}" (appliesIn: "${appliesIn}")`,
      };
    }
  }
  return { ok: true };
}

/**
 * service-scoped override bound. Provable disjointness is narrow (binding —
 * see finding writeup): a service-scoped override is disjoint from an org
 * actionId-dimension policy only when the catalog proves that action belongs
 * to a DIFFERENT service; it is NEVER provably disjoint from an org
 * riskLevel-dimension policy (a service can contain actions of any risk
 * level). Over-strict rejection (blocking when disjointness merely can't be
 * PROVEN) is the accepted trade-off over under-strict — see the `ask an org
 * admin` wording in `blockedByOrgPolicy`.
 */
async function validateServiceOverrideBounds(
  db: AppDb,
  orgId: string,
  service: string,
  now: number,
  actionPluginByService: ActionPluginByService,
): Promise<TargetValidation> {
  const rows = await loadLiveOrgPolicyDimensionRows(db, orgId, now);
  for (const row of rows) {
    if (row.mode !== "deny" && row.mode !== "require_approval") continue;
    if (row.service !== null) {
      if (row.service === service) return blockedByOrgPolicy(row);
      continue; // different service — provably disjoint
    }
    if (row.actionId !== null) {
      const found = findCatalogAction(actionPluginByService, row.actionId);
      if (!found || found.service === service) return blockedByOrgPolicy(row);
      continue; // catalog proves a different service — disjoint
    }
    // row.riskLevel dimension — never provably disjoint from a service scope.
    return blockedByOrgPolicy(row);
  }
  return { ok: true };
}

/**
 * riskLevel-scoped override bound. Per the same provable-disjointness rule:
 * a riskLevel-scoped override is never provably disjoint from an org
 * service- or actionId-dimension policy (either could cover actions at this
 * risk level) — those always block. An org riskLevel-dimension policy only
 * blocks when it targets the SAME risk level (a different risk level is
 * genuinely disjoint, no catalog lookup needed).
 */
async function validateRiskLevelOverrideBounds(
  db: AppDb,
  orgId: string,
  riskLevel: RiskLevel,
  now: number,
): Promise<TargetValidation> {
  const rows = await loadLiveOrgPolicyDimensionRows(db, orgId, now);
  for (const row of rows) {
    if (row.mode !== "deny" && row.mode !== "require_approval") continue;
    if (row.riskLevel !== null) {
      if (row.riskLevel === riskLevel) return blockedByOrgPolicy(row);
      continue; // different risk level — disjoint
    }
    // service or actionId dimension — never provably disjoint from a
    // riskLevel scope.
    return blockedByOrgPolicy(row);
  }
  return { ok: true };
}

/**
 * Enforces spec decision 3: a per-user override may only LOOSEN to `allow`
 * where the org's own policy CANNOT resolve tighter than `allow` for
 * anything the override could cover — not just the override's own exact
 * target dimension. `resolvePolicyDecision` (`resolution.ts`) places a
 * per-user override at rung 2, ABOVE org allow/require_approval (rung 3): an
 * actionId-scoped override that only bounds itself against actionId-
 * dimension org policies leaves service- and riskLevel-dimension org
 * policies for that same action free to be silently outranked at real
 * invocation time (the CRITICAL cross-dimension bypass this function used to
 * have). Tightening (`require_approval`/`deny`) is never restricted — a user
 * can always self-restrict further than the org allows.
 *
 * TOCTOU disclosure: this reads `action_policies` fresh but not inside the
 * same transaction as the override insert/update below, so a concurrent
 * admin write between this check and the write below is possible in
 * principle. Accepted, not fixed: the real resolution path (`resolution.ts`)
 * re-derives the decision from live rows on EVERY invocation — it never
 * trusts this write-time check — so a stale assessment here doesn't grant a
 * stale outcome for lingering invocations. The worst outcome of losing this
 * race is a transient window where a bypass override exists that a
 * subsequent admin write immediately re-supersedes on the next invocation,
 * not a permanent hole — unlike the cross-dimension gap this function now
 * closes, which WAS a permanent hole (the override, once written, stays at
 * rung 2 forever, so nothing at invocation time would ever re-check it
 * against the org policy it bypassed).
 */
export async function validateOverrideBounds(
  db: AppDb,
  orgId: string,
  target: PolicyTarget,
  mode: ApprovalMode,
  now: number,
  actionPluginByService: ActionPluginByService,
): Promise<TargetValidation> {
  if (mode !== "allow") return { ok: true };
  if (target.actionId !== undefined) {
    return validateActionIdOverrideBounds(db, orgId, target.actionId, now, actionPluginByService);
  }
  if (target.service !== undefined) {
    return validateServiceOverrideBounds(db, orgId, target.service, now, actionPluginByService);
  }
  if (target.riskLevel !== undefined) {
    return validateRiskLevelOverrideBounds(db, orgId, target.riskLevel, now);
  }
  // Unreachable when `target` already passed `validateTarget` — every call
  // site validates first. Defensive fallback rather than a type assertion.
  throw new Error("target must have exactly one of service, actionId, riskLevel set");
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
  actionPluginByService: ActionPluginByService,
): Promise<UpsertOverrideResult> {
  const targetCheck = validateTarget(input);
  if (!targetCheck.ok) return targetCheck;

  const boundsCheck = await validateOverrideBounds(db, orgId, input, input.mode, input.now, actionPluginByService);
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
