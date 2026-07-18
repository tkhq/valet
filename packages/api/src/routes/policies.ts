/**
 * `/api/org/policies` — org-admin CRUD over `action_policies`, a resolver
 * preview endpoint, and `/api/org/action-log` — keyset-paginated read over
 * `action_invocations` (action-policies plan, Task 4).
 *
 * Same DB-backed `requireOrgAdmin` gate as `routes/org.ts`/`routes/
 * llm-providers.ts` (not the JWT-role variant `routes/credentials.ts`
 * uses) — every route below 403s `{ error: "org admin required" }` for
 * non-admins. Rows are always scoped to the caller's own org
 * (`orgId = user.orgId`); a row belonging to another org 404s exactly like
 * a nonexistent id — this route never leaks cross-org existence via a 403.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import {
  ACTION_LOG_DEFAULT_LIMIT,
  ACTION_LOG_MAX_LIMIT,
  createOrgPolicy,
  decodeActionLogCursor,
  isApprovalMode,
  isRiskLevel,
  listActionLog,
  listOrgPolicies,
  revokeOrgPolicy,
  updateOrgPolicy,
  validateTarget,
  type ActionLogFilters,
} from "../policies/admin.js";
import { resolveActionPolicy } from "../policies/service.js";
import { validateParamMatchers } from "../policies/matchers.js";
import type { ActionInvocationRow, ActionPolicyRow } from "../schema/index.js";
import type {
  ActionLogEntryWire,
  ActionPolicyWire,
  CreateOrgPolicyRequest,
  CreateOrgPolicyResponse,
  DeleteOrgPolicyResponse,
  ListActionLogResponse,
  ListOrgPoliciesResponse,
  PatchOrgPolicyRequest,
  PatchOrgPolicyResponse,
  PreviewOrgPolicyRequest,
  PreviewOrgPolicyResponse,
} from "../wire/types.js";

export const policiesRouter = new Hono<AppEnv>();
export const actionLogRouter = new Hono<AppEnv>();

const POLICY_NOT_FOUND = { error: "policy not found" } as const;

function toPolicyWire(row: ActionPolicyRow): ActionPolicyWire {
  return {
    id: row.id,
    service: row.service,
    actionId: row.actionId,
    riskLevel: row.riskLevel,
    mode: row.mode,
    paramMatchers: row.paramMatchers,
    appliesIn: row.appliesIn,
    origin: row.origin,
    managedBy: row.managedBy,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toActionLogWire(row: ActionInvocationRow): ActionLogEntryWire {
  return {
    invocationId: row.invocationId,
    createdAt: row.createdAt,
    service: row.service,
    actionId: row.actionId,
    riskLevel: row.riskLevel,
    resolvedMode: row.resolvedMode,
    baseMode: row.baseMode,
    matchedPolicyId: row.matchedPolicyId,
    matchedGrantId: row.matchedGrantId,
    matchedOverrideId: row.matchedOverrideId,
    status: row.status,
    sessionId: row.sessionId,
    workflowExecutionId: row.workflowExecutionId,
    userId: row.userId,
    params: row.params,
    paramsTruncated: row.paramsTruncated,
    result: row.result,
    resultTruncated: row.resultTruncated,
    error: row.error,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
  };
}

// ── GET / — list ──────────────────────────────────────────────────────────

policiesRouter.get("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const rows = await listOrgPolicies(db, user.orgId);
  const resp: ListOrgPoliciesResponse = { policies: rows.map(toPolicyWire) };
  return c.json(resp);
});

// ── POST / — create ──────────────────────────────────────────────────────

policiesRouter.post("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateOrgPolicyRequest;
  try {
    body = (await c.req.json()) as CreateOrgPolicyRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const targetCheck = validateTarget(body);
  if (!targetCheck.ok) return c.json({ error: targetCheck.error }, 400);
  if (body.service !== undefined && typeof body.service !== "string") {
    return c.json({ error: "service must be a string" }, 400);
  }
  if (body.actionId !== undefined && typeof body.actionId !== "string") {
    return c.json({ error: "actionId must be a string" }, 400);
  }
  if (body.riskLevel !== undefined && !isRiskLevel(body.riskLevel)) {
    return c.json({ error: "riskLevel must be one of low|medium|high|critical" }, 400);
  }
  if (!isApprovalMode(body.mode)) {
    return c.json({ error: "mode must be one of allow|require_approval|deny" }, 400);
  }
  if (body.appliesIn !== undefined && !["any", "workflow", "session"].includes(body.appliesIn)) {
    return c.json({ error: "appliesIn must be one of any|workflow|session" }, 400);
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && typeof body.expiresAt !== "number") {
    return c.json({ error: "expiresAt must be a number or null" }, 400);
  }

  let paramMatchers;
  try {
    paramMatchers = validateParamMatchers(body.paramMatchers);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const now = Date.now();
  const row = await createOrgPolicy(db, user.orgId, {
    service: body.service,
    actionId: body.actionId,
    riskLevel: body.riskLevel,
    mode: body.mode,
    paramMatchers,
    appliesIn: body.appliesIn,
    expiresAt: body.expiresAt,
    managedBy: user.id,
    now,
  });
  const resp: CreateOrgPolicyResponse = toPolicyWire(row);
  return c.json(resp, 201);
});

// ── PATCH /:id — update rule fields ──────────────────────────────────────

policiesRouter.patch("/:id", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  let body: PatchOrgPolicyRequest;
  try {
    body = (await c.req.json()) as PatchOrgPolicyRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.mode !== undefined && !isApprovalMode(body.mode)) {
    return c.json({ error: "mode must be one of allow|require_approval|deny" }, 400);
  }
  if (body.appliesIn !== undefined && !["any", "workflow", "session"].includes(body.appliesIn)) {
    return c.json({ error: "appliesIn must be one of any|workflow|session" }, 400);
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && typeof body.expiresAt !== "number") {
    return c.json({ error: "expiresAt must be a number or null" }, 400);
  }

  let paramMatchers: ReturnType<typeof validateParamMatchers> | undefined;
  if (body.paramMatchers !== undefined) {
    try {
      paramMatchers = validateParamMatchers(body.paramMatchers);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  const updated = await updateOrgPolicy(db, user.orgId, id, {
    mode: body.mode,
    paramMatchers,
    appliesIn: body.appliesIn,
    expiresAt: body.expiresAt,
    now: Date.now(),
  });
  if (!updated) return c.json(POLICY_NOT_FOUND, 404);
  const resp: PatchOrgPolicyResponse = toPolicyWire(updated);
  return c.json(resp);
});

// ── DELETE /:id — soft-revoke ─────────────────────────────────────────────

policiesRouter.delete("/:id", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const revoked = await revokeOrgPolicy(db, user.orgId, id, Date.now());
  if (!revoked) return c.json(POLICY_NOT_FOUND, 404);
  const resp: DeleteOrgPolicyResponse = toPolicyWire(revoked);
  return c.json(resp);
});

// ── POST /preview — dry-run the resolver, no writes ──────────────────────

policiesRouter.post("/preview", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: PreviewOrgPolicyRequest;
  try {
    body = (await c.req.json()) as PreviewOrgPolicyRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body.service !== "string" || body.service.length === 0) {
    return c.json({ error: "service is required" }, 400);
  }
  if (typeof body.actionId !== "string" || body.actionId.length === 0) {
    return c.json({ error: "actionId is required" }, 400);
  }
  if (!isRiskLevel(body.riskLevel)) {
    return c.json({ error: "riskLevel must be one of low|medium|high|critical" }, 400);
  }
  if (body.appliesIn !== "session" && body.appliesIn !== "workflow") {
    return c.json({ error: "appliesIn must be one of session|workflow" }, 400);
  }
  if (body.appliesIn === "session" && typeof body.sessionId !== "string") {
    return c.json({ error: "sessionId is required when appliesIn is session" }, 400);
  }
  if (body.appliesIn === "workflow" && typeof body.workflowExecutionId !== "string") {
    return c.json({ error: "workflowExecutionId is required when appliesIn is workflow" }, 400);
  }

  const decision = await resolveActionPolicy(db, {
    orgId: user.orgId,
    userId: body.userId,
    service: body.service,
    actionId: body.actionId,
    riskLevel: body.riskLevel,
    params: body.params,
    appliesIn: body.appliesIn,
    sessionId: body.sessionId,
    workflowExecutionId: body.workflowExecutionId,
    pluginDefault: undefined,
    now: Date.now(),
  });
  const resp: PreviewOrgPolicyResponse = decision;
  return c.json(resp);
});

// ── GET /api/org/action-log — keyset-paginated read ──────────────────────

function isActionInvocationStatus(v: string): v is NonNullable<ActionInvocationRow["status"]> {
  return ["allowed", "denied", "approved", "rejected", "error", "completed"].includes(v);
}

actionLogRouter.get("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  const limitParam = c.req.query("limit");
  let limit = ACTION_LOG_DEFAULT_LIMIT;
  if (limitParam !== undefined) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    limit = Math.min(parsed, ACTION_LOG_MAX_LIMIT);
  }

  const cursorParam = c.req.query("cursor");
  let cursor: { s: number; id: string } | undefined;
  if (cursorParam !== undefined) {
    const decoded = decodeActionLogCursor(cursorParam);
    if (!decoded) return c.json({ error: "invalid cursor" }, 400);
    cursor = decoded;
  }

  const filters: ActionLogFilters = {};
  const service = c.req.query("service");
  if (service !== undefined) filters.service = service;
  const userId = c.req.query("userId");
  if (userId !== undefined) filters.userId = userId;
  const resolvedMode = c.req.query("resolvedMode");
  if (resolvedMode !== undefined) {
    if (!isApprovalMode(resolvedMode)) {
      return c.json({ error: "resolvedMode must be one of allow|require_approval|deny" }, 400);
    }
    filters.resolvedMode = resolvedMode;
  }
  const status = c.req.query("status");
  if (status !== undefined) {
    if (!isActionInvocationStatus(status)) {
      return c.json({ error: "status must be one of allowed|denied|approved|rejected|error|completed" }, 400);
    }
    filters.status = status;
  }
  const from = c.req.query("from");
  if (from !== undefined) {
    const parsed = Number.parseInt(from, 10);
    if (!Number.isFinite(parsed)) return c.json({ error: "from must be an epoch-ms integer" }, 400);
    filters.from = parsed;
  }
  const to = c.req.query("to");
  if (to !== undefined) {
    const parsed = Number.parseInt(to, 10);
    if (!Number.isFinite(parsed)) return c.json({ error: "to must be an epoch-ms integer" }, 400);
    filters.to = parsed;
  }

  const page = await listActionLog(db, user.orgId, filters, limit, cursor);
  const resp: ListActionLogResponse = {
    entries: page.rows.map(toActionLogWire),
    nextCursor: page.nextCursor ?? null,
  };
  return c.json(resp);
});

export type PoliciesRouter = typeof policiesRouter;
export type ActionLogRouter = typeof actionLogRouter;
