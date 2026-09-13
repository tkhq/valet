import {
  authorizationSha256Hex,
  canonicalAuthorizationJson,
  buildActionObligationPlan,
  decisionDigestOf,
  inputDigestOf,
  requestSubjectDigest,
  type AuthorizationRequest,
  type FactProvenance,
  type PolicyDecisionEnvelope,
} from "@valet/engine/authorization";
import type { AuthorizationDecisionRow, AuthorizationExecutionAttemptRow } from "../schema/index.js";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export type AuditAdapterErrorCode = "invalid_identity" | "digest_mismatch" | "invalid_proof" | "invalid_attempt";
export class AuditAdapterError extends TypeError {
  constructor(readonly code: AuditAdapterErrorCode) { super(`Authorization audit adapter rejected the input (${code}).`); this.name = "AuditAdapterError"; }
}

export interface DecisionAuditEvidenceV1 {
  readonly schemaVersion: 1;
  readonly profileDigest: string;
  readonly interpreterDigest: string;
  readonly contractDigest: string;
  readonly decisionDigest: string;
  readonly obligationDigest: string;
}
export interface DecisionAuditPlanV1 { readonly schemaVersion: 1; readonly row: AuthorizationDecisionRow; readonly evidence: DecisionAuditEvidenceV1 }

export function buildDecisionAuditPlan(input: {
  readonly decisionId: string;
  readonly request: AuthorizationRequest;
  readonly envelope: PolicyDecisionEnvelope;
  readonly profileDigest: string;
  readonly interpreterDigest: string;
  readonly contractDigest: string;
  readonly identityFactProvenance: readonly FactProvenance[];
  readonly policyFactProvenance: readonly FactProvenance[];
  readonly proofVerification?: { readonly status: "verified" | "failed"; readonly atMs: number; readonly errorCode?: string };
  readonly createdAtMs: number;
}): DecisionAuditPlanV1 {
  const { request, envelope } = input;
  validId(input.decisionId); timestamp(input.createdAtMs);
  for (const value of [input.profileDigest, input.interpreterDigest, input.contractDigest, envelope.inputDigest, envelope.policyDigest, envelope.sourceBundleDigest, envelope.evaluator.engineDigest]) digest(value);
  if (envelope.requestId !== request.requestId || envelope.requestSubjectDigest !== requestSubjectDigest(request) || envelope.inputDigest !== inputDigestOf(request)) fail("digest_mismatch");
  buildActionObligationPlan(envelope.decision);
  if (new Set(envelope.decision.matchedRuleIds).size !== envelope.decision.matchedRuleIds.length) fail("invalid_identity");
  const decisionDigest = decisionDigestOf(envelope.decision), obligationDigest = authorizationSha256Hex(canonicalAuthorizationJson({ obligations: envelope.decision.obligations, redactions: envelope.decision.redactions }));
  const tvc = envelope.evaluator.kind === "tvc_attested";
  if (tvc !== Boolean(envelope.proof) || tvc !== Boolean(input.proofVerification)) fail("invalid_proof");
  if (envelope.proof) {
    exact(envelope.proof, ["formatVersion", "keyId", "claimsDigest", "signature", "attestationDocument"]);
    if (!Number.isSafeInteger(envelope.proof.formatVersion) || envelope.proof.formatVersion < 1 || !envelope.proof.keyId || !HEX.test(envelope.proof.claimsDigest) || !envelope.proof.signature || !envelope.proof.attestationDocument) fail("invalid_proof");
  }
  const verification = input.proofVerification;
  if (verification) timestamp(verification.atMs);
  const row: AuthorizationDecisionRow = {
    decisionId: input.decisionId, orgId: request.subject.orgId, requestId: request.requestId,
    idempotencyKey: request.idempotencyKey, requestSubjectDigest: envelope.requestSubjectDigest,
    inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest,
    evaluatorKind: envelope.evaluator.kind, evaluatorEngineDigest: envelope.evaluator.engineDigest,
    effect: envelope.decision.effect, reasonCode: envelope.decision.reasonCode,
    matchedRuleIds: [...envelope.decision.matchedRuleIds].sort(), obligations: envelope.decision.obligations.map(copy), redactions: envelope.decision.redactions.map(copy),
    approvalRequirement: envelope.decision.approvalRequirement ? copy(envelope.decision.approvalRequirement) : null,
    proof: envelope.proof ? copy(envelope.proof) : null,
    proofVerificationStatus: verification?.status ?? "not_required", proofVerifiedAt: verification?.atMs ?? null,
    proofVerificationError: verification?.errorCode ? safeCode(verification.errorCode) : null,
    identityFactProvenance: input.identityFactProvenance.map(copy), policyFactProvenance: input.policyFactProvenance.map(copy),
    evaluatedAt: envelope.evaluatedAtMs, createdAt: input.createdAtMs,
  };
  return deepFreeze({ schemaVersion: 1, row, evidence: { schemaVersion: 1, profileDigest: input.profileDigest, interpreterDigest: input.interpreterDigest, contractDigest: input.contractDigest, decisionDigest, obligationDigest } });
}

export interface ExecutionAuditPlanV1 { readonly schemaVersion: 1; readonly row: AuthorizationExecutionAttemptRow; readonly requestSubjectDigest: string; readonly resultDigest: string | null }
export function buildExecutionAuditPlan(input: {
  readonly attemptId: string;
  readonly decision: DecisionAuditPlanV1;
  readonly request: AuthorizationRequest;
  readonly outcome: AuthorizationExecutionAttemptRow["outcome"];
  readonly targetIdempotencyKey?: string;
  readonly resultDigest?: string;
  readonly externalOperationIds?: readonly string[];
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
  readonly error?: unknown;
  readonly createdAtMs: number;
}): ExecutionAuditPlanV1 {
  validId(input.attemptId); timestamp(input.startedAtMs); timestamp(input.createdAtMs);
  if (input.decision.row.requestId !== input.request.requestId || input.decision.row.requestSubjectDigest !== requestSubjectDigest(input.request)) fail("invalid_identity");
  if (!(["started", "completed", "failed", "cancelled", "indeterminate"] as string[]).includes(input.outcome)) fail("invalid_attempt");
  if (input.finishedAtMs !== undefined) { timestamp(input.finishedAtMs); if (input.finishedAtMs < input.startedAtMs) fail("invalid_attempt"); }
  if ((input.outcome === "started") === (input.finishedAtMs !== undefined)) fail("invalid_attempt");
  if (input.resultDigest !== undefined) digest(input.resultDigest);
  if (input.targetIdempotencyKey !== undefined) validId(input.targetIdempotencyKey);
  const externalOperationIds = [...new Set(input.externalOperationIds ?? [])].sort(); externalOperationIds.forEach(validId);
  const row: AuthorizationExecutionAttemptRow = { attemptId: input.attemptId, decisionId: input.decision.row.decisionId, outcome: input.outcome, targetIdempotencyKey: input.targetIdempotencyKey ?? null, redactedResult: input.resultDigest ? { digest: input.resultDigest } : null, redactedError: input.error === undefined ? null : "Action execution failed.", externalOperationIds, startedAt: input.startedAtMs, finishedAt: input.finishedAtMs ?? null, createdAt: input.createdAtMs };
  return deepFreeze({ schemaVersion: 1, row, requestSubjectDigest: input.decision.row.requestSubjectDigest, resultDigest: input.resultDigest ?? null });
}

function copy<T>(value: T): T { return JSON.parse(canonicalAuthorizationJson(value)) as T; }
function digest(value: string): void { if (!HEX.test(value)) fail("digest_mismatch"); }
function validId(value: string): void { if (!ID.test(value)) fail("invalid_identity"); }
function timestamp(value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail("invalid_attempt"); }
function safeCode(value: string): string { return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : "proof_verification_failed"; }
function exact(value: object, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_proof"); }
function fail(code: AuditAdapterErrorCode): never { throw new AuditAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
