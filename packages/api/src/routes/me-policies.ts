/**
 * `/api/me/policy-overrides`, `/api/me/grants` — the caller's own
 * per-user policy overrides and runtime grants (action-policies plan,
 * Task 4). No org-admin gate — any authed org member manages their own
 * rows here; the write-time bounds check (`validateOverrideBounds`) is
 * what stops a member from self-granting past an org `deny`/
 * `require_approval` policy, not a role gate.
 *
 * Both `PUT`/`DELETE .../policy-overrides` address the row by its TARGET
 * triple (`service`/`actionId`/`riskLevel`), not by a row id — a caller has
 * at most one override per target (enforced by `upsertOverride`'s
 * find-or-insert), so the target IS the natural key. `DELETE` carries the
 * target in the request body (no per-row id exists in the URL to delete
 * by) — see `wire/types.ts`'s `DeletePolicyOverrideRequest` doc comment.
 *
 * `DELETE .../grants` similarly addresses by scope (`sessionId` XOR
 * `workflowExecutionId`) + `service`/`actionId` rather than by id, and
 * soft-revokes (`revokedAt` stamp) rather than row-deleting — matching
 * `policies/service.ts`'s `revokeSessionGrants`/`revokeExecutionGrants`
 * convention for every other grant-clearing path in this codebase.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  deleteOverrideByTarget,
  isApprovalMode,
  isRiskLevel,
  listMyGrants,
  listMyOverrides,
  revokeMyGrant,
  upsertOverride,
  validateTarget,
} from "../policies/admin.js";
import { validateParamMatchers } from "../policies/matchers.js";
import type { ActionPolicyOverrideRow, RuntimeGrantRow } from "../schema/index.js";
import type {
  ActionPolicyOverrideWire,
  DeleteGrantRequest,
  DeleteGrantResponse,
  DeletePolicyOverrideRequest,
  DeletePolicyOverrideResponse,
  ListGrantsResponse,
  ListPolicyOverridesResponse,
  PutPolicyOverrideRequest,
  PutPolicyOverrideResponse,
  RuntimeGrantWire,
} from "../wire/types.js";

export const mePolicyOverridesRouter = new Hono<AppEnv>();
export const meGrantsRouter = new Hono<AppEnv>();

function toOverrideWire(row: ActionPolicyOverrideRow): ActionPolicyOverrideWire {
  return {
    id: row.id,
    service: row.service,
    actionId: row.actionId,
    riskLevel: row.riskLevel,
    mode: row.mode,
    paramMatchers: row.paramMatchers,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toGrantWire(row: RuntimeGrantRow): RuntimeGrantWire {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workflowExecutionId: row.workflowExecutionId,
    policyKey: row.policyKey,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
  };
}

// ── GET /api/me/policy-overrides — list ──────────────────────────────────

mePolicyOverridesRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const rows = await listMyOverrides(db, user.orgId, user.id);
  const resp: ListPolicyOverridesResponse = { overrides: rows.map(toOverrideWire) };
  return c.json(resp);
});

// ── PUT /api/me/policy-overrides — upsert by target ──────────────────────

mePolicyOverridesRouter.put("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: PutPolicyOverrideRequest;
  try {
    body = (await c.req.json()) as PutPolicyOverrideRequest;
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

  let paramMatchers;
  try {
    paramMatchers = validateParamMatchers(body.paramMatchers);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const result = await upsertOverride(db, user.orgId, user.id, {
    service: body.service,
    actionId: body.actionId,
    riskLevel: body.riskLevel,
    mode: body.mode,
    paramMatchers,
    now: Date.now(),
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  const resp: PutPolicyOverrideResponse = toOverrideWire(result.row);
  return c.json(resp);
});

// ── DELETE /api/me/policy-overrides — delete by target ───────────────────

mePolicyOverridesRouter.delete("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: DeletePolicyOverrideRequest;
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as DeletePolicyOverrideRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const targetCheck = validateTarget(body);
  if (!targetCheck.ok) return c.json({ error: targetCheck.error }, 400);

  const deleted = await deleteOverrideByTarget(db, user.orgId, user.id, body);
  if (!deleted) return c.json({ error: "override not found" }, 404);

  const resp: DeletePolicyOverrideResponse = { ok: true };
  return c.json(resp);
});

// ── GET /api/me/grants — list ─────────────────────────────────────────────

meGrantsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const rows = await listMyGrants(db, user.orgId, user.id);
  const resp: ListGrantsResponse = { grants: rows.map(toGrantWire) };
  return c.json(resp);
});

// ── DELETE /api/me/grants — revoke by scope + policy key ─────────────────

meGrantsRouter.delete("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: DeleteGrantRequest;
  try {
    body = (await c.req.json()) as DeleteGrantRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body.service !== "string" || body.service.length === 0) {
    return c.json({ error: "service is required" }, 400);
  }
  if (typeof body.actionId !== "string" || body.actionId.length === 0) {
    return c.json({ error: "actionId is required" }, 400);
  }
  const hasSession = typeof body.sessionId === "string";
  const hasWorkflow = typeof body.workflowExecutionId === "string";
  if (hasSession === hasWorkflow) {
    return c.json({ error: "exactly one of sessionId, workflowExecutionId is required" }, 400);
  }

  const revoked = await revokeMyGrant(
    db,
    user.orgId,
    user.id,
    {
      sessionId: body.sessionId,
      workflowExecutionId: body.workflowExecutionId,
      service: body.service,
      actionId: body.actionId,
    },
    Date.now(),
  );
  if (!revoked) return c.json({ error: "grant not found" }, 404);

  const resp: DeleteGrantResponse = { ok: true };
  return c.json(resp);
});

export type MePolicyOverridesRouter = typeof mePolicyOverridesRouter;
export type MeGrantsRouter = typeof meGrantsRouter;
