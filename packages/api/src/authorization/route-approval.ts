import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ApprovalRequirement } from "@valet/engine/authorization";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { requireActingUser } from "../middleware/auth.js";
import { authorizationDecisions, canonicalApprovalResolutions, type AuthorizationDecisionRow } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import { canAdministerTeam } from "../services/teams.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;

export interface ResolveRouteApprovalRequestV1 {
  readonly schemaVersion: 1;
  readonly verdict: "approved" | "rejected";
}

export interface ResolveRouteApprovalResponseV1 {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly resolutionId: string;
  readonly verdict: "approved" | "rejected";
}

export const routeApprovalRouter = new Hono<AppEnv>();

routeApprovalRouter.post("/decisions/:decisionId/resolve", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "Sign in with a user account to resolve this approval." }, 401);
  const decisionId = c.req.param("decisionId");
  if (!ID.test(decisionId)) return c.json({ error: "Send a valid authorization decision ID." }, 400);
  let body: ResolveRouteApprovalRequestV1;
  try { body = await c.req.json<ResolveRouteApprovalRequestV1>(); }
  catch { return c.json({ error: "Send a JSON approval resolution." }, 400); }
  if (body.schemaVersion !== 1 || (body.verdict !== "approved" && body.verdict !== "rejected")) {
    return c.json({ error: "Send schemaVersion 1 and an approved or rejected verdict." }, 400);
  }

  const db = c.var.providers.db;
  const original = (await db.select().from(authorizationDecisions).where(and(
    eq(authorizationDecisions.decisionId, decisionId), eq(authorizationDecisions.orgId, user.orgId),
  )).limit(1))[0];
  if (!isRouteApproval(original)) return c.json({ error: "Authorization decision not found." }, 404);
  try { c.var.providers.canonicalAuthorizationService.verifyPersistedDecision(original); }
  catch { return c.json({ error: "Authorization decision evidence is invalid. Request a new decision." }, 409); }
  if (!(await mayResolve(db, user.id, user.orgId, original.approvalRequirement))) {
    return c.json({ error: "This approval requires a different approver. Ask an authorized administrator." }, 403);
  }

  const resolutionId = routeApprovalResolutionId(original, user.id, body.verdict);
  const now = Date.now();
  await db.insert(canonicalApprovalResolutions).values({
    resolutionId, approvalId: original.decisionId, gateId: original.decisionId, orgId: original.orgId,
    requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence!.decisionDigest,
    approverId: user.id, verdict: body.verdict, appliesIn: "route", scopeKind: "route", scopeId: routeOperationId(original),
    resolvedAt: now, expiresAt: original.approvalRequirement.expiresAtMs ?? now + 72 * 60 * 60 * 1000,
    resolutionVersion: 1,
  }).onConflictDoNothing();
  const stored = (await db.select().from(canonicalApprovalResolutions).where(eq(canonicalApprovalResolutions.resolutionId, resolutionId)).limit(1))[0];
  if (!stored || stored.approvalId !== original.decisionId || stored.approverId !== user.id || stored.verdict !== body.verdict) {
    return c.json({ error: "Approval resolution could not be persisted. Retry the same resolution." }, 503);
  }
  const response: ResolveRouteApprovalResponseV1 = { schemaVersion: 1, decisionId, resolutionId, verdict: body.verdict };
  return c.json(response);
});

function isRouteApproval(row: AuthorizationDecisionRow | undefined): row is AuthorizationDecisionRow & { approvalRequirement: ApprovalRequirement; evidence: NonNullable<AuthorizationDecisionRow["evidence"]> } {
  return row !== undefined && row.effect === "require_approval" && row.approvalRequirement !== null && row.evidence !== null && row.idempotencyKey.startsWith("route:");
}

function routeOperationId(row: AuthorizationDecisionRow): string {
  const id = row.idempotencyKey.slice("route:".length);
  if (!ID.test(id)) throw new Error("Canonical route approval operation identity is invalid.");
  return id;
}

async function mayResolve(db: AppDb, userId: string, orgId: string, requirement: ApprovalRequirement): Promise<boolean> {
  if (requirement.approverType === "org") return (!requirement.approverId || requirement.approverId === orgId) && isOrgAdmin(db, orgId, userId);
  if (requirement.approverType === "team") return requirement.approverId !== undefined && canAdministerTeam(db, requirement.approverId, userId);
  return requirement.approverId === userId;
}

function routeApprovalResolutionId(row: AuthorizationDecisionRow, approverId: string, verdict: string): string {
  return `resolution:${createHash("sha256").update(`${row.decisionId}\0${approverId}\0${verdict}`).digest("hex")}`;
}
