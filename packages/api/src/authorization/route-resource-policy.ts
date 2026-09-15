import { createHash, randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { adaptApiRoute, buildRouteResourceObligationPlan, inputDigestOf, requestSubjectDigest, type AuthorizationRequest, type CurrentPolicyDynamicFactsV2, type PolicyDecisionEnvelope, type RouteResourceObligationPlanV1 } from "@valet/engine/authorization";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, canonicalApprovalResolutions } from "../schema/index.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { requirePrincipal, requireUser } from "../middleware/auth.js";
import { buildApiRouteRegistry, isProtectedBoundaryExclusion, type ApiRouteDescriptorV1, type PolicyRisk, type ResourceKind, type ResourceOperation } from "./route-resource-registry.js";

export { API_ROUTE_DESCRIPTOR_SEEDS_V1, ROUTE_BOUNDARY_EXCLUSIONS_V1, WS_OPERATION_DESCRIPTOR_SEEDS_V1, buildApiRouteRegistry, mergeApiRouteDescriptorMapsV1 } from "./route-resource-registry.js";
export type { ApiRouteDescriptorV1, PolicyRisk, ResourceKind, ResourceOperation } from "./route-resource-registry.js";

export interface ResourceAccessDescriptorV1 {
  readonly schemaVersion: 1;
  readonly resourceKind: ResourceKind;
  readonly operation: ResourceOperation;
  readonly service: string;
  readonly actionId: string;
  readonly riskLevel: PolicyRisk;
  readonly safeMetadata: readonly ["resourceId", "ownerType", "ownerId", "version"];
}

export const RESOURCE_ACCESS_DESCRIPTOR_SEEDS_V1: Readonly<Record<string, readonly [PolicyRisk]>> = Object.freeze({
  "repository.list": ["low"],
  "repository.metadata": ["low"],
  "repository.read": ["low"],
  "repository.link": ["low"],
  "repository.unlink": ["low"],
  "repository.import": ["medium"],
  "secret.list": ["high"],
  "secret.metadata": ["high"],
  "secret.create": ["high"],
  "secret.update": ["high"],
  "secret.delete": ["high"],
  "secret.attach": ["high"],
  "secret.use": ["high"],
  "policy.list": ["low"],
  "policy.read": ["low"],
  "policy.create": ["medium"],
  "policy.update": ["medium"],
  "policy.delete": ["high"],
  "policy.approve": ["high"],
  "policy.publish": ["high"],
  "workflow.list": ["low"],
  "workflow.read": ["low"],
  "workflow.create": ["medium"],
  "workflow.update": ["medium"],
  "workflow.delete": ["high"],
  "workflow.execute": ["medium"],
  "workflow.approve": ["high"],
  "workflow.cancel": ["low"],
  "workflow.copy": ["low"],
  "workflow.import": ["medium"],
  "workflow.export": ["medium"],
  "artifact.list": ["low"],
  "artifact.metadata": ["low"],
  "artifact.read": ["low"],
  "artifact.create": ["medium"],
  "artifact.update": ["medium"],
  "artifact.delete": ["high"],
  "artifact.share": ["medium"],
  "artifact.publish": ["high"],
  "artifact.copy": ["low"],
  "session.list": ["low"],
  "session.read": ["low"],
  "session.create": ["medium"],
  "session.update": ["medium"],
  "session.delete": ["high"],
  "session.execute": ["medium"],
  "session.approve": ["high"],
  "session.cancel": ["low"],
  "assistant.list": ["low"],
  "assistant.read": ["low"],
  "assistant.create": ["medium"],
  "assistant.update": ["medium"],
  "assistant.delete": ["high"],
  "assistant.execute": ["medium"],
  "team.list": ["low"],
  "team.read": ["low"],
  "team.create": ["medium"],
  "team.update": ["medium"],
  "team.delete": ["high"],
  "team.approve": ["high"],
});

export const RESOURCE_ACCESS_REGISTRY: readonly ResourceAccessDescriptorV1[] = Object.freeze(
  Object.entries(RESOURCE_ACCESS_DESCRIPTOR_SEEDS_V1).map(([key, [riskLevel]]) => {
    const split = key.indexOf(".");
    const resourceKind = key.slice(0, split) as ResourceKind, operation = key.slice(split + 1) as ResourceOperation;
    return Object.freeze({ schemaVersion: 1 as const, resourceKind, operation, service: `resource_${resourceKind}`,
      actionId: `resource_${resourceKind}.${operation}`, riskLevel, safeMetadata: ["resourceId", "ownerType", "ownerId", "version"] as const });
  }),
);

export function routeResourcePolicyMiddleware(registry: () => readonly ApiRouteDescriptorV1[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isProtectedBoundaryExclusion(c.req.method, c.req.path)) { await next(); return; }
    const user = requireUser(c), principal = requirePrincipal(c);
    if (!user || !principal) return c.json({ error: "Authorization identity is unavailable. Authenticate again.", code: "authorization_identity_missing" }, 401);
    const matched = resolveRouteDescriptor(registry(), c.req.method, c.req.path);
    if (!matched) return c.json({ error: "This API route has no authorization descriptor. Contact an administrator.", code: "authorization_descriptor_missing" }, 403);
    const delivery = deliveryIdentity(c.req.header("Idempotency-Key"));
    let obligationPlan: RouteResourceObligationPlanV1;
    try {
      const evaluationTimeMs = Date.now();
      const descriptor = { schemaVersion: 1 as const, service: matched.descriptor.service, actionId: matched.descriptor.actionId, method: matched.descriptor.method, routeTemplate: matched.descriptor.template, riskLevel: matched.descriptor.riskLevel };
      const initial = adaptApiRoute({ schemaVersion: 1, organizationId: user.orgId, actorUserId: user.id, principal, requestId: delivery, operationId: `${delivery}:route`, evaluationTimeMs, descriptor });
      const replay = await loadApprovedRouteReplay(c.var.providers.db, initial.request, c.req.header("X-Valet-Approval-Resolution"), evaluationTimeMs);
      if (replay?.verdict === "rejected") return c.json({ error: "The approval was rejected. Ask an administrator to review access.", code: "authorization_approval_rejected" }, 403);
      const routeRequest = replay === undefined ? initial.request : adaptApiRoute({ schemaVersion: 1, organizationId: user.orgId, actorUserId: user.id, principal, requestId: `${delivery}:approved`, operationId: replay.operationId, evaluationTimeMs, descriptor, dynamicFacts: { currentPolicy: replay.facts }, approvalBindingContext: replay.binding, approvalScopeId: initial.request.subject.invocation.id }).request;
      const routeDecision = await c.var.providers.canonicalAuthorizationService.authorize(routeRequest);
      obligationPlan = buildRouteResourceObligationPlan(routeDecision.decision);
      if (routeDecision.decision.effect === "require_approval" && c.req.header("Idempotency-Key") === undefined) return c.json({ error: "Send an Idempotency-Key before requesting approval.", code: "authorization_idempotency_required" }, 428);
      const routeRefusal = refusal(routeDecision, canonicalDecisionId(user.orgId, routeRequest.idempotencyKey));
      if (routeRefusal) return c.json(routeRefusal.body, routeRefusal.status);
      if (obligationPlan.readOnly && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return c.json({ error: "Policy permits read-only access. Use a read operation or ask an administrator to change access.", code: "authorization_read_only" }, 403);
      if (obligationPlan.resultLimit !== undefined || obligationPlan.fieldMask !== undefined || obligationPlan.redactions.length > 0) return c.json({ error: "This route does not support the required policy obligation. Ask an administrator to change the policy.", code: "authorization_obligation_unsupported" }, 403);
    } catch {
      return c.json({ error: "Authorization could not be completed. Retry with the same Idempotency-Key.", code: "authorization_indeterminate" }, 503);
    }
    await next();
  };
}

export function resolveRouteDescriptor(registry: readonly ApiRouteDescriptorV1[], method: string, path: string): { descriptor: ApiRouteDescriptorV1; resourceId?: string } | undefined {
  for (const descriptor of registry) {
    if (descriptor.method !== method.toUpperCase() && descriptor.method !== "ALL") continue;
    const matched = matchTemplate(descriptor.template, path);
    if (matched) return { descriptor, ...(matched.resourceId === undefined ? {} : { resourceId: matched.resourceId }) };
  }
  return undefined;
}

function refusal(envelope: PolicyDecisionEnvelope, decisionId: string): { status: 403 | 409; body: { error: string; code: string; decisionId?: string } } | undefined {
  if (envelope.decision.effect === "allow") return undefined;
  if (envelope.decision.effect === "deny") return { status: 403, body: { error: "Policy denied this operation. Ask an administrator to review access.", code: "authorization_denied" } };
  return { status: 409, body: { error: "This operation requires approval. Resolve the durable decision, then retry the unchanged request.", code: "authorization_approval_required", decisionId } };
}

export async function loadApprovedRouteReplay(db: AppDb, initial: AuthorizationRequest, resolutionId: string | undefined, evaluationTimeMs: number): Promise<{ verdict: "approved" | "rejected"; operationId: string; facts: CurrentPolicyDynamicFactsV2; binding: { requestSubjectDigest: string; originalDecisionDigest: string } } | undefined> {
  if (resolutionId === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(resolutionId)) throw new Error("Route approval resolution identity is invalid.");
  const decisionId = canonicalDecisionId(initial.subject.orgId, initial.idempotencyKey);
  const original = (await db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.decisionId, decisionId), eq(authorizationDecisions.orgId, initial.subject.orgId))).limit(1))[0];
  if (!original?.evidence || original.effect !== "require_approval" || original.requestId !== initial.requestId || original.requestSubjectDigest !== requestSubjectDigest(initial) || original.inputDigest !== inputDigestOf(initial)) throw new Error("Route approval does not match this request.");
  const resolution = (await db.select().from(canonicalApprovalResolutions).where(and(eq(canonicalApprovalResolutions.resolutionId, resolutionId), eq(canonicalApprovalResolutions.orgId, initial.subject.orgId))).limit(1))[0];
  const scopeId = initial.subject.invocation.id;
  if (!resolution || resolution.approvalId !== original.decisionId || resolution.requestSubjectDigest !== original.requestSubjectDigest || resolution.originalDecisionDigest !== original.evidence.decisionDigest || resolution.appliesIn !== "route" || resolution.sessionId !== scopeId || resolution.revokedAt !== null || resolution.expiresAt <= evaluationTimeMs) throw new Error("Route approval does not match this request.");
  const binding = { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest };
  const facts = await loadCanonicalDynamicFacts(db, { organizationId: original.orgId, service: initial.action.service!, actionId: initial.action.id, riskLevel: initial.action.riskLevel as "low" | "medium" | "high" | "critical", appliesIn: "route", scopeId, evaluationTimeMs, ...binding });
  return { verdict: resolution.verdict, operationId: `approved:${createHash("sha256").update(`${scopeId}\0${resolutionId}`).digest("hex")}`, facts, binding };
}
function descriptorFor(kind: ResourceKind, operation: ResourceOperation): ResourceAccessDescriptorV1 {
  const descriptor = RESOURCE_ACCESS_REGISTRY.find((entry) => entry.resourceKind === kind && entry.operation === operation);
  if (!descriptor) throw new Error(`Resource operation ${kind}.${operation} has no descriptor.`);
  return descriptor;
}

function deliveryIdentity(value: string | undefined): string {
  const source = value === undefined ? randomUUID() : `retry:${value}`;
  return `http:${createHash("sha256").update(source).digest("hex")}`;
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
