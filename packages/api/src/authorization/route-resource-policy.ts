import { createHash, randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { adaptApiRoute, buildRouteResourceObligationPlan, inputDigestOf, requestSubjectDigest, type AuthorizationRequest, type CurrentPolicyDynamicFactsV2, type PolicyDecisionEnvelope, type RouteResourceObligationPlanV1 } from "@valet/engine/authorization";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { authorizationDecisions, authorizationExecutionAttempts, canonicalApprovalResolutions } from "../schema/index.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { requirePrincipal, requireUser } from "../middleware/auth.js";
import { buildApiRouteRegistry, isProtectedBoundaryExclusion, type ApiRouteDescriptorV1, type PolicyRisk, type ResourceKind, type ResourceOperation } from "./route-resource-registry.js";

export { API_ROUTE_DESCRIPTOR_SEEDS_V1, ROUTE_BOUNDARY_EXCLUSIONS_V1, WS_OPERATION_DESCRIPTOR_SEEDS_V1, buildApiRouteRegistry, mergeApiRouteDescriptorMapsV1 } from "./route-resource-registry.js";
export type { ApiRouteDescriptorV1, PolicyRisk, ResourceAccessDescriptorV1, ResourceKind, ResourceOperation } from "./route-resource-registry.js";

export { RESOURCE_ACCESS_DESCRIPTOR_SEEDS_V1, RESOURCE_ACCESS_REGISTRY } from "./route-resource-registry.js";

export function routeResourcePolicyMiddleware(registry: () => readonly ApiRouteDescriptorV1[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isProtectedBoundaryExclusion(c.req.method, c.req.path)) { await next(); return; }
    const matched = resolveRouteDescriptor(registry(), c.req.method, c.req.path);
    if (!matched) return c.json({ error: "This API route has no authorization descriptor. Contact an administrator.", code: "authorization_descriptor_missing" }, 403);
    const user = requireUser(c), principal = requirePrincipal(c);
    if (!user || !principal) {
      if (isInternalSecurityRoute(c.req.method, matched.descriptor.template, c.req.header("x-valet-internal")) || isInternalArtifactRoute(c.req.method, c.req.path, c.req.header("x-valet-internal"), c.req.header("x-valet-owner"), c.req.header("x-valet-actor"))) { await next(); return; }
      return c.json({ error: "Authorization identity is unavailable. Authenticate again.", code: "authorization_identity_missing" }, 401);
    }
    const delivery = deliveryIdentity();
    const mutationKey = c.req.header("Idempotency-Key");
    const executionDigest = ["GET", "HEAD", "OPTIONS"].includes(c.req.method) ? undefined : await requestExecutionDigest(c.req.raw, matched.descriptor.actionId);
    let obligationPlan: RouteResourceObligationPlanV1;
    let executionAttemptId: string | undefined;
    let executionDecisionId: string | undefined;
    try {
      const evaluationTimeMs = Date.now();
      const descriptor = { schemaVersion: 1 as const, service: matched.descriptor.service, actionId: matched.descriptor.actionId, method: matched.descriptor.method, routeTemplate: matched.descriptor.template, riskLevel: matched.descriptor.riskLevel };
      const initial = adaptApiRoute({ schemaVersion: 1, organizationId: user.orgId, actorUserId: user.id, principal, requestId: delivery, operationId: `${delivery}:route`, evaluationTimeMs, descriptor, ...(executionDigest === undefined ? {} : { safeMetadata: { requestDigest: executionDigest } }) });
      const replay = await loadApprovedRouteReplay(c.var.providers.db, initial.request, c.req.header("X-Valet-Approval-Resolution"), evaluationTimeMs, (row) => c.var.providers.canonicalAuthorizationService.verifyPersistedDecision(row));
      if (replay?.verdict === "rejected") return c.json({ error: "The approval was rejected. Ask an administrator to review access.", code: "authorization_approval_rejected" }, 403);
      const routeRequest = replay === undefined ? initial.request : adaptApiRoute({ schemaVersion: 1, organizationId: user.orgId, actorUserId: user.id, principal, requestId: `${delivery}:approved`, operationId: replay.operationId, evaluationTimeMs, descriptor, dynamicFacts: { currentPolicy: replay.facts }, approvalBindingContext: replay.binding, approvalScopeId: replay.scopeId, ...(executionDigest === undefined ? {} : { safeMetadata: { requestDigest: executionDigest } }) }).request;
      const routeDecision = await c.var.providers.canonicalAuthorizationService.authorize(routeRequest);
      obligationPlan = buildRouteResourceObligationPlan(routeDecision.decision);
      if (routeDecision.decision.effect === "require_approval" && matched.descriptor.actionId === "api_authorization.post_authorization_decisions_item_resolve") {
        return c.json({ error: "Approval resolution cannot require another approval. Ask an organization administrator to change the route policy.", code: "authorization_recursive_approval" }, 403);
      }
      if (routeDecision.decision.effect === "require_approval" && c.req.header("Idempotency-Key") === undefined) return c.json({ error: "Send an Idempotency-Key before requesting approval.", code: "authorization_idempotency_required" }, 428);
      const routeRefusal = refusal(routeDecision, canonicalDecisionId(user.orgId, routeRequest.idempotencyKey));
      if (routeRefusal) return c.json(routeRefusal.body, routeRefusal.status);
      if (obligationPlan.readOnly && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return c.json({ error: "Policy permits read-only access. Use a read operation or ask an administrator to change access.", code: "authorization_read_only" }, 403);
      if (obligationPlan.resultLimit !== undefined || obligationPlan.fieldMask !== undefined || obligationPlan.redactions.length > 0) return c.json({ error: "This route does not support the required policy obligation. Ask an administrator to change the policy.", code: "authorization_obligation_unsupported" }, 403);
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
        const reserved = await reserveRouteExecution(c.var.providers.db, canonicalDecisionId(user.orgId, routeRequest.idempotencyKey), { orgId: user.orgId, actorId: user.id, actionId: matched.descriptor.actionId, key: mutationKey ?? delivery, digest: executionDigest! }, evaluationTimeMs);
        if (reserved.kind === "completed") return replayRouteResponse(reserved.output);
        if (reserved.kind === "indeterminate") return c.json({ error: "The operation may have completed. Inspect its state before you retry.", code: "authorization_indeterminate" }, 409);
        executionAttemptId = reserved.attemptId;
        executionDecisionId = reserved.decisionId;
      }
    } catch (error) {
      if (error instanceof RouteExecutionConflict) return c.json({ error: "The Idempotency-Key was already used for a different request.", code: "authorization_idempotency_conflict" }, 409);
      return c.json({ error: "Authorization could not be completed. Retry with the same Idempotency-Key.", code: "authorization_indeterminate" }, 503);
    }
    try {
      await next();
      if (executionAttemptId && executionDecisionId) await settleRouteExecution(c.var.providers.db, executionAttemptId, executionDecisionId, await boundedRouteResponse(c.res), "completed", Date.now());
    } catch (error) {
      if (executionAttemptId && executionDecisionId) await settleRouteExecution(c.var.providers.db, executionAttemptId, executionDecisionId, undefined, "indeterminate", Date.now());
      throw error;
    }
  };
}

function isInternalSecurityRoute(method: string, template: string, token: string | undefined): boolean {
  return (method.toUpperCase() === "GET" || method.toUpperCase() === "POST")
    && (template === "/api/sessions/:id/security" || template.startsWith("/api/sessions/:id/security/"))
    && isValidInternalToken(token);
}

function isInternalArtifactRoute(method: string, path: string, token: string | undefined, owner: string | undefined, actor: string | undefined): boolean {
  return method.toUpperCase() === "POST" && path === "/api/artifacts/share" && owner !== undefined && actor !== undefined && isValidInternalToken(token);
}

export function resolveRouteDescriptor(registry: readonly ApiRouteDescriptorV1[], method: string, path: string): { descriptor: ApiRouteDescriptorV1; resourceId?: string } | undefined {
  const candidates = registry
    .filter((descriptor) => descriptor.method === method.toUpperCase() || descriptor.method === "ALL")
    .map((descriptor) => ({ descriptor, matched: matchTemplate(descriptor.template, path) }))
    .filter((candidate): candidate is { descriptor: ApiRouteDescriptorV1; matched: { resourceId?: string } } => candidate.matched !== undefined)
    .sort((left, right) => templateSpecificity(right.descriptor.template) - templateSpecificity(left.descriptor.template));
  const selected = candidates[0];
  return selected === undefined ? undefined : { descriptor: selected.descriptor, ...(selected.matched.resourceId === undefined ? {} : { resourceId: selected.matched.resourceId }) };
}

function templateSpecificity(template: string): number {
  return template.split("/").filter(Boolean).reduce((score, segment) => score + (segment === "*" ? 0 : segment.startsWith(":") ? 1 : 2), 0);
}

function refusal(envelope: PolicyDecisionEnvelope, decisionId: string): { status: 403 | 409; body: { error: string; code: string; decisionId?: string } } | undefined {
  if (envelope.decision.effect === "allow") return undefined;
  if (envelope.decision.effect === "deny") return { status: 403, body: { error: "Policy denied this operation. Ask an administrator to review access.", code: "authorization_denied" } };
  return { status: 409, body: { error: "This operation requires approval. Resolve the durable decision, then retry the unchanged request.", code: "authorization_approval_required", decisionId } };
}

export async function loadApprovedRouteReplay(db: AppDb, initial: AuthorizationRequest, resolutionId: string | undefined, evaluationTimeMs: number, verifyDecision?: (row: typeof authorizationDecisions.$inferSelect) => unknown): Promise<{ verdict: "approved" | "rejected"; operationId: string; scopeId: string; facts: CurrentPolicyDynamicFactsV2; binding: { requestSubjectDigest: string; originalDecisionDigest: string } } | undefined> {
  if (resolutionId === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(resolutionId)) throw new Error("Route approval resolution identity is invalid.");
  const resolution = (await db.select().from(canonicalApprovalResolutions).where(and(eq(canonicalApprovalResolutions.resolutionId, resolutionId), eq(canonicalApprovalResolutions.orgId, initial.subject.orgId))).limit(1))[0];
  if (!resolution || resolution.appliesIn !== "route" || resolution.scopeKind !== "route" || !resolution.scopeId || resolution.revokedAt !== null || resolution.expiresAt <= evaluationTimeMs) throw new Error("Route approval does not match this request.");
  const original = (await db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.decisionId, resolution.approvalId), eq(authorizationDecisions.orgId, initial.subject.orgId))).limit(1))[0];
  const replay = original?.evidence?.approvalReplay;
  const route = replay?.route;
  const parameters = initial.action.parameters as Record<string, unknown> | undefined;
  const metadata = parameters?.metadata as Record<string, unknown> | undefined;
  const requestDigest = metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.requestDigest === "string" ? metadata.requestDigest : undefined;
  if (!original?.evidence || original.effect !== "require_approval" || replay?.actorUserId !== initial.subject.actorUserId || !route || route.method !== parameters?.method || route.template !== parameters?.template || route.actionId !== initial.action.id || route.requestDigest !== requestDigest) throw new Error("Route approval does not match this request.");
  verifyDecision?.(original);
  if (resolution.requestSubjectDigest !== original.requestSubjectDigest || resolution.originalDecisionDigest !== original.evidence.decisionDigest || resolution.scopeId !== original.idempotencyKey.slice("route:".length)) throw new Error("Route approval does not match this request.");
  const binding = { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest };
  const facts = await loadCanonicalDynamicFacts(db, { organizationId: original.orgId, service: initial.action.service!, actionId: initial.action.id, riskLevel: initial.action.riskLevel as "low" | "medium" | "high" | "critical", appliesIn: "route", scopeId: resolution.scopeId, evaluationTimeMs, ...binding });
  return { verdict: resolution.verdict, operationId: `approved:${createHash("sha256").update(`${resolution.scopeId}\0${resolutionId}`).digest("hex")}`, scopeId: resolution.scopeId, facts, binding };
}

function deliveryIdentity(): string {
  return `http:${createHash("sha256").update(randomUUID()).digest("hex")}`;
}

function matchTemplate(template: string, path: string): { resourceId?: string } | undefined {
  const expected = template.split("/").filter(Boolean), actual = path.split("/").filter(Boolean);
  if (expected.at(-1) !== "*" && expected.length !== actual.length) return undefined;
  if (expected.at(-1) === "*" && actual.length < expected.length - 1) return undefined;
  let resourceId: string | undefined;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] === "*") return resourceId === undefined ? {} : { resourceId };
    if (expected[index]?.startsWith(":")) { resourceId ??= actual[index]; continue; }
    if (expected[index] !== actual[index]) return undefined;
  }
  return resourceId === undefined ? {} : { resourceId };
}


type StoredRouteResponse = { status: number; contentType: string; body: unknown; outputAvailable: boolean };
type RouteExecutionReservation =
  | { kind: "execute"; attemptId: string; decisionId: string }
  | { kind: "completed"; output: StoredRouteResponse }
  | { kind: "indeterminate" };

class RouteExecutionConflict extends Error {}

async function requestExecutionDigest(request: Request, actionId: string): Promise<string> {
  const url = new URL(request.url);
  const body = await request.clone().arrayBuffer();
  return createHash("sha256").update(actionId).update("\0").update(request.method).update("\0").update(url.pathname).update("\0").update(url.search).update("\0").update(new Uint8Array(body)).digest("hex");
}

async function reserveRouteExecution(db: AppDb, decisionId: string, identity: { orgId: string; actorId: string; actionId: string; key: string; digest: string }, now: number): Promise<RouteExecutionReservation> {
  const stable = createHash("sha256").update(`${identity.orgId}\0${identity.actorId}\0${identity.actionId}\0${identity.key}`).digest("hex");
  const attemptId = `attempt:${stable}`;
  const binding = `request:${identity.digest}`;
  const inserted = await db.insert(authorizationExecutionAttempts).values({ attemptId, decisionId, outcome: "started", targetIdempotencyKey: identity.key, externalOperationIds: [binding], startedAt: now, createdAt: now }).onConflictDoNothing().returning({ attemptId: authorizationExecutionAttempts.attemptId });
  if (inserted[0]) return { kind: "execute", attemptId, decisionId };
  const prior = (await db.select().from(authorizationExecutionAttempts).where(eq(authorizationExecutionAttempts.attemptId, attemptId)).limit(1))[0];
  if (!prior || prior.targetIdempotencyKey !== identity.key || prior.externalOperationIds.length !== 1 || prior.externalOperationIds[0] !== binding) throw new RouteExecutionConflict();
  const output = storedRouteResponse(prior.redactedResult);
  if (prior.outcome === "completed" && output) return { kind: "completed", output };
  return { kind: "indeterminate" };
}

async function settleRouteExecution(db: AppDb, attemptId: string, decisionId: string, output: StoredRouteResponse | undefined, outcome: "completed" | "indeterminate", now: number): Promise<void> {
  await db.update(authorizationExecutionAttempts).set({ outcome, redactedResult: output ?? null, redactedError: outcome === "indeterminate" ? "The handler did not return a response." : null, finishedAt: now }).where(and(eq(authorizationExecutionAttempts.attemptId, attemptId), eq(authorizationExecutionAttempts.decisionId, decisionId), eq(authorizationExecutionAttempts.outcome, "started")));
}

const MAX_ROUTE_REPLAY_BYTES = 65_536;
async function boundedRouteResponse(response: Response): Promise<StoredRouteResponse> {
  const contentType = response.headers.get("content-type") ?? "application/json; charset=UTF-8";
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  if (!contentType.toLowerCase().includes("application/json") || bytes.byteLength > MAX_ROUTE_REPLAY_BYTES) return { status: response.status, contentType: "application/json; charset=UTF-8", body: { code: "completed_output_unavailable" }, outputAvailable: false };
  try { return { status: response.status, contentType, body: redactReplayJson(JSON.parse(new TextDecoder().decode(bytes))), outputAvailable: true }; }
  catch { return { status: response.status, contentType: "application/json; charset=UTF-8", body: { code: "completed_output_unavailable" }, outputAvailable: false }; }
}

function redactReplayJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReplayJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /token|secret|password|credential|authorization/i.test(key) ? "[REDACTED]" : redactReplayJson(entry)]));
}

function storedRouteResponse(value: unknown): StoredRouteResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.status) || (row.status as number) < 100 || (row.status as number) > 599 || typeof row.contentType !== "string" || typeof row.outputAvailable !== "boolean" || !("body" in row)) return undefined;
  return { status: row.status as number, contentType: row.contentType, body: row.body, outputAvailable: row.outputAvailable };
}

function replayRouteResponse(output: StoredRouteResponse): Response {
  return new Response(JSON.stringify(output.body), { status: output.status, headers: { "content-type": output.contentType, "x-valet-execution-replay": "true" } });
}
