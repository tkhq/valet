import type { DecisionGateRequest, PolicyDecision, PolicyResolver, PolicyResolveInput } from "../types.js";
import { authorizationSha256Hex, canonicalAuthorizationJson, requestSubjectDigest } from "./identity.js";
import { trustedJsonClone } from "./trusted-json.js";
import type { ApprovalRequirement, AuthorizationRequest, Obligation, PolicyDecisionEnvelope, PolicyDecisionV1, RedactionDirective } from "./types.js";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
export type AuthorizationAdapterFailureCode = "invalid_decision" | "service_error" | "bundle_not_found" | "unsupported_context" | "unsupported_obligation" | "invalid_binding" | "expired_approval";
export class AuthorizationAdapterError extends Error {
  constructor(readonly code: AuthorizationAdapterFailureCode) { super(`Authorization adapter failed closed (${code}).`); this.name = "AuthorizationAdapterError"; }
}

export interface ActionObligationPlanV1 {
  readonly schemaVersion: 1;
  readonly preExecution: readonly ({ readonly type: "credential_owner"; readonly ownerType: string; readonly ownerId: string } | { readonly type: "target_idempotency"; readonly required: true })[];
  readonly postExecution: readonly RedactionDirective[];
}

/** Builds instructions only. The caller remains responsible for enforcement at cutover. */
export function buildActionObligationPlan(untrusted: PolicyDecisionV1): ActionObligationPlanV1 {
  let decision: PolicyDecisionV1;
  try { decision = trustedJsonClone(untrusted); } catch { fail("invalid_decision"); }
  exact(decision, ["effect", "reasonCode", "matchedRuleIds", "obligations", "redactions", "approvalRequirement"]);
  if ((decision.effect !== "allow" && decision.effect !== "deny" && decision.effect !== "require_approval") || typeof decision.reasonCode !== "string" || !/^[a-z0-9_.:-]{1,128}$/.test(decision.reasonCode) || !Array.isArray(decision.matchedRuleIds) || decision.matchedRuleIds.some((id) => typeof id !== "string" || !ID.test(id)) || !Array.isArray(decision.obligations) || !Array.isArray(decision.redactions)) fail("invalid_decision");
  if ((decision.effect === "require_approval") !== (decision.approvalRequirement !== undefined)) fail("invalid_decision");
  if (decision.approvalRequirement !== undefined) validateApprovalRequirement(decision.approvalRequirement);
  const seen = new Map<string, string>();
  const preExecution: ActionObligationPlanV1["preExecution"][number][] = [];
  for (const obligation of decision.obligations) {
    if (!record(obligation) || (obligation.type !== "credential_owner" && obligation.type !== "target_idempotency")) fail("unsupported_obligation");
    exact(obligation, obligation.type === "credential_owner" ? ["type", "ownerType", "ownerId"] : ["type", "required"]);
    if (obligation.type === "target_idempotency" && obligation.required !== true) fail("unsupported_obligation");
    if (obligation.type === "credential_owner" && ((obligation.ownerType !== "user" && obligation.ownerType !== "team" && obligation.ownerType !== "org") || typeof obligation.ownerId !== "string" || !ID.test(obligation.ownerId))) fail("unsupported_obligation");
    const value = canonicalAuthorizationJson(obligation), prior = seen.get(obligation.type);
    if (prior !== undefined && prior !== value) fail("unsupported_obligation");
    if (prior === undefined) preExecution.push(obligation);
    seen.set(obligation.type, value);
  }
  const postExecution = decision.redactions.map((redaction) => {
    if (!record(redaction)) fail("unsupported_obligation"); exact(redaction, ["target", "jsonPaths"]);
    if ((redaction.target !== "audit" && redaction.target !== "explanation" && redaction.target !== "user_output") || !Array.isArray(redaction.jsonPaths) || redaction.jsonPaths.some((path) => typeof path !== "string" || !path.startsWith("$") || path.length > 256)) fail("unsupported_obligation");
    return { ...redaction, jsonPaths: [...new Set(redaction.jsonPaths)].sort() };
  });
  return deepFreeze({ schemaVersion: 1, preExecution, postExecution });
}

function validateApprovalRequirement(value: ApprovalRequirement): void {
  if (!record(value)) fail("invalid_decision"); exact(value, ["tier", "approverType", "approverId", "replay", "expiresAtMs"]);
  if (typeof value.tier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.tier) || (value.approverType !== "user" && value.approverType !== "team" && value.approverType !== "org") || (value.replay !== "once" && value.replay !== "session" && value.replay !== "workflow") || (value.approverId !== undefined && (typeof value.approverId !== "string" || !ID.test(value.approverId))) || (value.expiresAtMs !== undefined && !timestamp(value.expiresAtMs))) fail("invalid_decision");
}

export interface CanonicalApprovalBindingV1 {
  readonly schemaVersion: 1; readonly requestId: string; readonly requestSubjectDigest: string; readonly inputDigest: string; readonly policyDigest: string; readonly decisionDigest: string;
  readonly sourceBundleDigest: string; readonly evaluatorKind: "local_valet" | "tvc_attested"; readonly engineDigest: string; readonly profileDigest: string; readonly interpreterDigest: string; readonly contractDigest: string;
  readonly actionId: string; readonly principalType: string; readonly principalId: string; readonly actorUserId?: string; readonly sessionId?: string; readonly workflowExecutionId?: string;
  readonly tier: string; readonly approverType: ApprovalRequirement["approverType"]; readonly approverId?: string; readonly replay: ApprovalRequirement["replay"]; readonly expiresAtMs?: number;
}
export interface CanonicalApprovalPlanV1 { readonly schemaVersion: 1; readonly binding: CanonicalApprovalBindingV1; readonly gate: DecisionGateRequest }
export interface CanonicalApprovalEvidenceV1 { readonly profileDigest: string; readonly interpreterDigest: string; readonly contractDigest: string }

export function buildCanonicalApprovalPlan(untrustedRequest: AuthorizationRequest, untrustedEnvelope: PolicyDecisionEnvelope, evidence: CanonicalApprovalEvidenceV1): CanonicalApprovalPlanV1 {
  let request: AuthorizationRequest;
  try { request = trustedJsonClone(untrustedRequest); } catch { fail("invalid_decision"); }
  const envelope = assertEnvelope(request, untrustedEnvelope);
  let trustedEvidence: CanonicalApprovalEvidenceV1;
  try { trustedEvidence = trustedJsonClone(evidence); } catch { fail("invalid_binding"); }
  exact(trustedEvidence, ["profileDigest", "interpreterDigest", "contractDigest"]);
  for (const value of [trustedEvidence.profileDigest, trustedEvidence.interpreterDigest, trustedEvidence.contractDigest]) if (!hex(value)) fail("invalid_binding");
  const requirement = envelope.decision.approvalRequirement;
  if (envelope.decision.effect !== "require_approval" || requirement === undefined) fail("invalid_decision");
  const decisionDigest = decisionDigestOf(envelope.decision);
  const binding = deepFreeze({ schemaVersion: 1 as const, requestId: request.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, decisionDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, ...trustedEvidence, actionId: request.action.id, principalType: request.subject.principal.type, principalId: request.subject.principal.id, ...(request.subject.actorUserId === undefined ? {} : { actorUserId: request.subject.actorUserId }), ...(request.subject.sessionId === undefined ? {} : { sessionId: request.subject.sessionId }), ...(request.subject.workflowExecutionId === undefined ? {} : { workflowExecutionId: request.subject.workflowExecutionId }), tier: requirement.tier, approverType: requirement.approverType, ...(requirement.approverId === undefined ? {} : { approverId: requirement.approverId }), replay: requirement.replay, ...(requirement.expiresAtMs === undefined ? {} : { expiresAtMs: requirement.expiresAtMs }) });
  const gate: DecisionGateRequest = deepFreeze({ type: "approval", title: `Approve ${request.action.id}?`, body: `Policy requires ${requirement.tier} approval.`, resumeKey: `policy:${envelope.requestSubjectDigest}:${decisionDigest}`, dedupeKey: `policy:${envelope.requestSubjectDigest}`, ...(requirement.expiresAtMs === undefined ? {} : { expiresAt: requirement.expiresAtMs }), context: { authorizationApproval: binding } });
  return deepFreeze({ schemaVersion: 1, binding, gate });
}

export function assertApprovalBinding(expected: CanonicalApprovalBindingV1, resumed: CanonicalApprovalBindingV1, nowMs: number): void {
  let left: CanonicalApprovalBindingV1, right: CanonicalApprovalBindingV1;
  try { left = trustedJsonClone(expected); right = trustedJsonClone(resumed); } catch { fail("invalid_binding"); }
  if (!timestamp(nowMs) || canonicalAuthorizationJson(left) !== canonicalAuthorizationJson(right)) fail("invalid_binding");
  if (left.expiresAtMs !== undefined && nowMs >= left.expiresAtMs) fail("expired_approval");
}

export interface CanonicalAuthorizationServiceLike { authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> }
/** Adapts only the canonical service. It has no alternate evaluator. */
export function authorizationServicePolicyResolver(service: CanonicalAuthorizationServiceLike, requestFor: (input: PolicyResolveInput) => AuthorizationRequest): PolicyResolver {
  return { async resolve(input): Promise<PolicyDecision> {
    try {
      const request = trustedJsonClone(requestFor(input));
      const envelope = assertEnvelope(request, await service.authorize(request));
      const decision = envelope.decision;
      return { mode: decision.effect, provenance: { baseMode: decision.effect, source: "canonical_service" }, canonical: deepFreeze({ reasonCode: decision.reasonCode, obligations: decision.obligations, redactions: decision.redactions, approvalRequirement: decision.approvalRequirement, requestId: request.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(decision) }) };
    } catch (error) {
      const reported = record(error) && typeof error.code === "string" ? error.code : "";
      const code: AuthorizationAdapterFailureCode = error instanceof AuthorizationAdapterError ? error.code : reported === "bundle_not_found" ? "bundle_not_found" : reported === "unsupported_context" ? "unsupported_context" : "service_error";
      return deepFreeze({ mode: "deny", provenance: { baseMode: "deny", source: "resolver_error" }, canonical: { reasonCode: `fail_closed.${code}`, obligations: [], redactions: [], requestId: "unavailable", requestSubjectDigest: "0".repeat(64), inputDigest: "0".repeat(64), policyDigest: "0".repeat(64), sourceBundleDigest: "0".repeat(64), evaluatorKind: "local_valet", engineDigest: "0".repeat(64), profileDigest: "0".repeat(64), interpreterDigest: "0".repeat(64), contractDigest: "0".repeat(64), decisionDigest: "0".repeat(64) } });
    }
  } };
}

export function decisionDigestOf(decision: PolicyDecisionV1): string { return authorizationSha256Hex(canonicalAuthorizationJson(decision)); }
export function obligationDigestOf(decision: PolicyDecisionV1): string { return authorizationSha256Hex(canonicalAuthorizationJson({ obligations: decision.obligations, redactions: decision.redactions })); }
export function inputDigestOf(request: AuthorizationRequest): string { return authorizationSha256Hex(canonicalAuthorizationJson(request)); }

/** Validates all bindings and returns a frozen envelope with no caller aliases. */
export function assertEnvelope(untrustedRequest: AuthorizationRequest, untrusted: PolicyDecisionEnvelope): PolicyDecisionEnvelope {
  let request: AuthorizationRequest, envelope: PolicyDecisionEnvelope;
  try { request = trustedJsonClone(untrustedRequest); envelope = trustedJsonClone(untrusted); } catch { fail("invalid_decision"); }
  validateActionRequest(request);
  exact(envelope, ["schemaVersion", "requestId", "requestSubjectDigest", "inputDigest", "policyDigest", "sourceBundleDigest", "evaluator", "decision", "evaluatedAtMs", "proof", "decisionDigest", "obligationDigest"]);
  if (envelope.schemaVersion !== 1 || typeof envelope.requestId !== "string" || envelope.requestId !== request.requestId || !hex(envelope.requestSubjectDigest) || envelope.requestSubjectDigest !== requestSubjectDigest(request) || !hex(envelope.inputDigest) || envelope.inputDigest !== inputDigestOf(request) || !hex(envelope.policyDigest) || !hex(envelope.sourceBundleDigest) || !timestamp(envelope.evaluatedAtMs)) fail("invalid_decision");
  if (!record(envelope.evaluator)) fail("invalid_decision"); exact(envelope.evaluator, ["kind", "engineDigest"]);
  if ((envelope.evaluator.kind !== "local_valet" && envelope.evaluator.kind !== "tvc_attested") || !hex(envelope.evaluator.engineDigest)) fail("invalid_decision");
  buildActionObligationPlan(envelope.decision);
  if ((envelope.evaluator.kind === "tvc_attested") !== (envelope.proof !== undefined)) fail("invalid_decision");
  if (envelope.proof !== undefined) {
    exact(envelope.proof, ["formatVersion", "keyId", "claimsDigest", "signature", "attestationDocument"]);
    if (!Number.isSafeInteger(envelope.proof.formatVersion) || envelope.proof.formatVersion < 1 || typeof envelope.proof.keyId !== "string" || envelope.proof.keyId.length === 0 || !hex(envelope.proof.claimsDigest) || typeof envelope.proof.signature !== "string" || envelope.proof.signature.length === 0 || typeof envelope.proof.attestationDocument !== "string" || envelope.proof.attestationDocument.length === 0) fail("invalid_decision");
  }
  if (envelope.decisionDigest !== undefined && (typeof envelope.decisionDigest !== "string" || envelope.decisionDigest !== decisionDigestOf(envelope.decision))) fail("invalid_decision");
  if (envelope.obligationDigest !== undefined && (typeof envelope.obligationDigest !== "string" || envelope.obligationDigest !== obligationDigestOf(envelope.decision))) fail("invalid_decision");
  return envelope;
}

function validateActionRequest(request: AuthorizationRequest): void {
  exact(request, ["schemaVersion", "requestId", "idempotencyKey", "kind", "subject", "action", "context", "facts", "resource", "approval"]);
  if (request.schemaVersion !== 1 || typeof request.requestId !== "string" || !ID.test(request.requestId) || (request.kind !== "tool.action" && request.kind !== "workflow.action") || !record(request.context) || !record(request.facts)) fail("invalid_decision");
  if (!record(request.subject)) fail("invalid_decision"); exact(request.subject, ["orgId", "principal", "invocation", "actorUserId", "sessionId", "threadId", "workflowExecutionId", "workflowNodeId", "parentSessionId"]);
  if (typeof request.subject.orgId !== "string" || !ID.test(request.subject.orgId) || !record(request.subject.principal) || !record(request.subject.invocation)) fail("invalid_decision");
  exact(request.subject.principal, ["type", "id"]); exact(request.subject.invocation, ["type", "id"]);
  if ((request.subject.principal.type !== "user" && request.subject.principal.type !== "team" && request.subject.principal.type !== "org") || typeof request.subject.principal.id !== "string" || !ID.test(request.subject.principal.id) || (request.subject.invocation.type !== "interactive" && request.subject.invocation.type !== "workflow") || typeof request.subject.invocation.id !== "string" || !ID.test(request.subject.invocation.id) || request.idempotencyKey !== `${request.subject.invocation.type}:${request.subject.invocation.id}`) fail("invalid_decision");
  for (const value of [request.subject.actorUserId, request.subject.sessionId, request.subject.threadId, request.subject.workflowExecutionId, request.subject.workflowNodeId, request.subject.parentSessionId]) if (value !== undefined && (typeof value !== "string" || !ID.test(value))) fail("invalid_decision");
  if (!record(request.action)) fail("invalid_decision"); exact(request.action, ["id", "service", "riskLevel", "parameters"]);
  if (typeof request.action.id !== "string" || !ID.test(request.action.id) || typeof request.action.service !== "string" || !ID.test(request.action.service) || typeof request.action.riskLevel !== "string" || !["low", "medium", "high", "critical"].includes(request.action.riskLevel) || !record(request.action.parameters)) fail("invalid_decision");
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[]): void { if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_decision"); }
function hex(value: unknown): value is string { return typeof value === "string" && HEX.test(value); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function fail(code: AuthorizationAdapterFailureCode): never { throw new AuthorizationAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
