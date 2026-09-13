import type { DecisionGateRequest, PolicyDecision, PolicyResolver, PolicyResolveInput } from "../types.js";
import { authorizationSha256Hex, canonicalAuthorizationJson, requestSubjectDigest } from "./identity.js";
import type { ApprovalRequirement, AuthorizationRequest, Obligation, PolicyDecisionEnvelope, PolicyDecisionV1, RedactionDirective } from "./types.js";

const HEX = /^[0-9a-f]{64}$/;
export type AuthorizationAdapterFailureCode = "invalid_decision" | "service_error" | "bundle_not_found" | "unsupported_context" | "unsupported_obligation" | "invalid_binding" | "expired_approval";
export class AuthorizationAdapterError extends Error {
  constructor(readonly code: AuthorizationAdapterFailureCode) { super(`Authorization adapter failed closed (${code}).`); this.name = "AuthorizationAdapterError"; }
}

export interface ActionObligationPlanV1 {
  readonly schemaVersion: 1;
  readonly preExecution: readonly (
    | { readonly type: "credential_owner"; readonly ownerType: string; readonly ownerId: string }
    | { readonly type: "target_idempotency"; readonly required: true }
  )[];
  readonly postExecution: readonly RedactionDirective[];
}

/** Builds instructions only. The caller remains responsible for enforcement at cutover. */
export function buildActionObligationPlan(decision: PolicyDecisionV1): ActionObligationPlanV1 {
  exact(decision, ["effect", "reasonCode", "matchedRuleIds", "obligations", "redactions", "approvalRequirement"]);
  if (!["allow", "deny", "require_approval"].includes(decision.effect) || !/^[a-z0-9_.:-]{1,128}$/.test(decision.reasonCode) || !Array.isArray(decision.matchedRuleIds) || decision.matchedRuleIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(id)) || !Array.isArray(decision.obligations) || !Array.isArray(decision.redactions)) fail("invalid_decision");
  if ((decision.effect === "require_approval") !== Boolean(decision.approvalRequirement)) fail("invalid_decision");
  if (decision.approvalRequirement) {
    exact(decision.approvalRequirement, ["tier", "approverType", "approverId", "replay", "expiresAtMs"]);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(decision.approvalRequirement.tier) || !["user", "team", "org"].includes(decision.approvalRequirement.approverType) || !["once", "session", "workflow"].includes(decision.approvalRequirement.replay) || (decision.approvalRequirement.approverId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(decision.approvalRequirement.approverId)) || (decision.approvalRequirement.expiresAtMs !== undefined && (!Number.isSafeInteger(decision.approvalRequirement.expiresAtMs) || decision.approvalRequirement.expiresAtMs < 0))) fail("invalid_decision");
  }
  const seen = new Map<string, string>();
  const preExecution: ActionObligationPlanV1["preExecution"][number][] = [];
  for (const obligation of decision.obligations) {
    if (obligation.type !== "credential_owner" && obligation.type !== "target_idempotency") fail("unsupported_obligation");
    exact(obligation, obligation.type === "credential_owner" ? ["type", "ownerType", "ownerId"] : ["type", "required"]);
    if (obligation.type === "target_idempotency" && obligation.required !== true) fail("unsupported_obligation");
    if (obligation.type === "credential_owner" && (!(["user", "team", "org"] as string[]).includes(obligation.ownerType) || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(obligation.ownerId))) fail("unsupported_obligation");
    const value = canonicalAuthorizationJson(obligation), prior = seen.get(obligation.type);
    if (prior && prior !== value) fail("unsupported_obligation");
    if (!prior) preExecution.push(obligation);
    seen.set(obligation.type, value);
  }
  const postExecution = decision.redactions.map((redaction) => {
    exact(redaction, ["target", "jsonPaths"]);
    if (!["audit", "explanation", "user_output"].includes(redaction.target) || !Array.isArray(redaction.jsonPaths) || redaction.jsonPaths.some((path) => typeof path !== "string" || !path.startsWith("$") || path.length > 256)) fail("unsupported_obligation");
    return { ...redaction, jsonPaths: [...new Set(redaction.jsonPaths)].sort() };
  });
  return deepFreeze({ schemaVersion: 1, preExecution, postExecution });
}

export interface CanonicalApprovalBindingV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestSubjectDigest: string;
  readonly inputDigest: string;
  readonly policyDigest: string;
  readonly decisionDigest: string;
  readonly actionId: string;
  readonly principalType: string;
  readonly principalId: string;
  readonly actorUserId?: string;
  readonly sessionId?: string;
  readonly workflowExecutionId?: string;
  readonly tier: string;
  readonly approverType: ApprovalRequirement["approverType"];
  readonly approverId?: string;
  readonly replay: ApprovalRequirement["replay"];
  readonly expiresAtMs?: number;
}

export interface CanonicalApprovalPlanV1 {
  readonly schemaVersion: 1;
  readonly binding: CanonicalApprovalBindingV1;
  readonly gate: DecisionGateRequest;
}

export function buildCanonicalApprovalPlan(request: AuthorizationRequest, envelope: PolicyDecisionEnvelope): CanonicalApprovalPlanV1 {
  assertEnvelope(request, envelope);
  buildActionObligationPlan(envelope.decision);
  const requirement = envelope.decision.approvalRequirement;
  if (envelope.decision.effect !== "require_approval" || !requirement) fail("invalid_decision");
  const decisionDigest = decisionDigestOf(envelope.decision);
  const binding = deepFreeze({ schemaVersion: 1 as const, requestId: request.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, decisionDigest, actionId: request.action.id, principalType: request.subject.principal.type, principalId: request.subject.principal.id, ...(request.subject.actorUserId ? { actorUserId: request.subject.actorUserId } : {}), ...(request.subject.sessionId ? { sessionId: request.subject.sessionId } : {}), ...(request.subject.workflowExecutionId ? { workflowExecutionId: request.subject.workflowExecutionId } : {}), tier: requirement.tier, approverType: requirement.approverType, ...(requirement.approverId ? { approverId: requirement.approverId } : {}), replay: requirement.replay, ...(requirement.expiresAtMs === undefined ? {} : { expiresAtMs: requirement.expiresAtMs }) });
  const gate: DecisionGateRequest = deepFreeze({ type: "approval", title: `Approve ${request.action.id}?`, body: `Policy requires ${requirement.tier} approval.`, resumeKey: `policy:${envelope.requestSubjectDigest}:${decisionDigest}`, dedupeKey: `policy:${envelope.requestSubjectDigest}`, ...(requirement.expiresAtMs === undefined ? {} : { expiresAt: requirement.expiresAtMs }), context: { authorizationApproval: binding } });
  return deepFreeze({ schemaVersion: 1, binding, gate });
}

export function assertApprovalBinding(expected: CanonicalApprovalBindingV1, resumed: CanonicalApprovalBindingV1, nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || canonicalAuthorizationJson(expected) !== canonicalAuthorizationJson(resumed)) fail("invalid_binding");
  if (expected.expiresAtMs !== undefined && nowMs >= expected.expiresAtMs) fail("expired_approval");
}

export interface CanonicalAuthorizationServiceLike { authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> }

/** Adapts only the canonical service. It never invokes or falls back to the legacy evaluator. */
export function authorizationServicePolicyResolver(service: CanonicalAuthorizationServiceLike, requestFor: (input: PolicyResolveInput) => AuthorizationRequest): PolicyResolver {
  return {
    async resolve(input): Promise<PolicyDecision> {
      try {
        const request = requestFor(input), envelope = await service.authorize(request);
        assertEnvelope(request, envelope);
        buildActionObligationPlan(envelope.decision);
        const decision = envelope.decision;
        if (!decision.reasonCode || !Array.isArray(decision.matchedRuleIds) || (decision.effect === "require_approval") !== Boolean(decision.approvalRequirement)) fail("invalid_decision");
        return { mode: decision.effect, provenance: { baseMode: decision.effect, source: "resolver_error" }, canonical: deepFreeze({ reasonCode: decision.reasonCode, obligations: decision.obligations, redactions: decision.redactions, approvalRequirement: decision.approvalRequirement, requestId: request.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, decisionDigest: decisionDigestOf(decision) }) };
      } catch (error) {
        const reported = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        const code: AuthorizationAdapterFailureCode = error instanceof AuthorizationAdapterError ? error.code : reported === "bundle_not_found" ? "bundle_not_found" : reported === "unsupported_context" ? "unsupported_context" : "service_error";
        return { mode: "deny", provenance: { baseMode: "deny", source: "resolver_error" }, canonical: { reasonCode: `fail_closed.${code}`, obligations: [], redactions: [], requestId: "unavailable", requestSubjectDigest: "0".repeat(64), inputDigest: "0".repeat(64), policyDigest: "0".repeat(64), decisionDigest: "0".repeat(64) } };
      }
    },
  };
}

export function decisionDigestOf(decision: PolicyDecisionV1): string { return authorizationSha256Hex(canonicalAuthorizationJson(decision)); }
export function inputDigestOf(request: AuthorizationRequest): string { return authorizationSha256Hex(canonicalAuthorizationJson(request)); }

function assertEnvelope(request: AuthorizationRequest, envelope: PolicyDecisionEnvelope): void {
  if (envelope.schemaVersion !== 1 || envelope.requestId !== request.requestId || envelope.requestSubjectDigest !== requestSubjectDigest(request) || ![envelope.requestSubjectDigest, envelope.inputDigest, envelope.policyDigest, envelope.sourceBundleDigest, envelope.evaluator.engineDigest].every((value) => HEX.test(value)) || !["allow", "deny", "require_approval"].includes(envelope.decision.effect)) fail("invalid_decision");
}
function exact(value: object, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_decision"); }
function fail(code: AuthorizationAdapterFailureCode): never { throw new AuthorizationAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
