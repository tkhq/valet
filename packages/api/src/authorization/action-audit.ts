import {
  assertEnvelope,
  decisionDigestOf,
  obligationDigestOf,
  requestSubjectDigest,
  trustedJsonClone,
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
  let request: AuthorizationRequest, supplied: PolicyDecisionEnvelope, envelope: PolicyDecisionEnvelope;
  try { request = trustedJsonClone(input.request); supplied = trustedJsonClone(input.envelope); } catch { fail("digest_mismatch"); }
  if ((supplied.evaluator?.kind !== "local_valet" && supplied.evaluator?.kind !== "tvc_attested") || (supplied.evaluator.kind === "tvc_attested") !== (supplied.proof !== undefined)) fail("invalid_proof");
  try { envelope = assertEnvelope(request, supplied); } catch { fail("digest_mismatch"); }
  validId(input.decisionId); validId(request.subject.orgId); validId(request.requestId); validId(request.idempotencyKey); timestamp(input.createdAtMs); timestamp(envelope.evaluatedAtMs);
  for (const value of [input.profileDigest, input.interpreterDigest, input.contractDigest, envelope.inputDigest, envelope.policyDigest, envelope.sourceBundleDigest, envelope.evaluator.engineDigest]) digest(value);
  if (new Set(envelope.decision.matchedRuleIds).size !== envelope.decision.matchedRuleIds.length) fail("invalid_identity");
  const decisionDigest = decisionDigestOf(envelope.decision), obligationDigest = obligationDigestOf(envelope.decision);
  const tvc = envelope.evaluator.kind === "tvc_attested";
  if (tvc !== Boolean(envelope.proof) || tvc !== Boolean(input.proofVerification)) fail("invalid_proof");
  if (envelope.proof) {
    exact(envelope.proof, ["formatVersion", "keyId", "claimsDigest", "signature", "attestationDocument"]);
    if (!Number.isSafeInteger(envelope.proof.formatVersion) || envelope.proof.formatVersion < 1 || typeof envelope.proof.keyId !== "string" || envelope.proof.keyId.length === 0 || typeof envelope.proof.claimsDigest !== "string" || !HEX.test(envelope.proof.claimsDigest) || typeof envelope.proof.signature !== "string" || envelope.proof.signature.length === 0 || typeof envelope.proof.attestationDocument !== "string" || envelope.proof.attestationDocument.length === 0) fail("invalid_proof");
  }
  const verification = input.proofVerification === undefined ? undefined : copy(input.proofVerification);
  if (verification) { exact(verification, ["status", "atMs", "errorCode"]); if (verification.status !== "verified" && verification.status !== "failed") fail("invalid_proof"); timestamp(verification.atMs); if (verification.errorCode !== undefined && typeof verification.errorCode !== "string") fail("invalid_proof"); }
  const identityFactProvenance = copy(input.identityFactProvenance), policyFactProvenance = copy(input.policyFactProvenance);
  validateProvenance(identityFactProvenance); validateProvenance(policyFactProvenance);
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
    identityFactProvenance: identityFactProvenance.map(copy), policyFactProvenance: policyFactProvenance.map(copy),
    evidence: { schemaVersion: 1, profileDigest: input.profileDigest, interpreterDigest: input.interpreterDigest, contractDigest: input.contractDigest, decisionDigest, obligationDigest },
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
  let decision: DecisionAuditPlanV1, request: AuthorizationRequest;
  try { decision = trustedJsonClone(input.decision); request = trustedJsonClone(input.request); } catch { fail("invalid_identity"); }
  validId(input.attemptId); timestamp(input.startedAtMs); timestamp(input.createdAtMs);
  if (decision.row.requestId !== request.requestId || decision.row.requestSubjectDigest !== requestSubjectDigest(request)) fail("invalid_identity");
  if (!(["started", "completed", "failed", "cancelled", "indeterminate"] as string[]).includes(input.outcome)) fail("invalid_attempt");
  if (input.finishedAtMs !== undefined) { timestamp(input.finishedAtMs); if (input.finishedAtMs < input.startedAtMs) fail("invalid_attempt"); }
  if ((input.outcome === "started") === (input.finishedAtMs !== undefined)) fail("invalid_attempt");
  if (input.resultDigest !== undefined) digest(input.resultDigest);
  if (input.targetIdempotencyKey !== undefined) validId(input.targetIdempotencyKey);
  let suppliedOperationIds: readonly string[];
  try { suppliedOperationIds = trustedJsonClone(input.externalOperationIds ?? []); } catch { fail("invalid_identity"); }
  const externalOperationIds = [...new Set(suppliedOperationIds)].sort(); externalOperationIds.forEach(validId);
  const row: AuthorizationExecutionAttemptRow = { attemptId: input.attemptId, decisionId: decision.row.decisionId, outcome: input.outcome, targetIdempotencyKey: input.targetIdempotencyKey ?? null, redactedResult: input.resultDigest ? { digest: input.resultDigest } : null, redactedError: input.error === undefined ? null : "Action execution failed.", externalOperationIds, startedAt: input.startedAtMs, finishedAt: input.finishedAtMs ?? null, createdAt: input.createdAtMs };
  return deepFreeze({ schemaVersion: 1, row, requestSubjectDigest: decision.row.requestSubjectDigest, resultDigest: input.resultDigest ?? null });
}

function copy<T>(value: T): T { try { return trustedJsonClone(value); } catch { fail("invalid_identity"); } }
function digest(value: unknown): void { if (typeof value !== "string" || !HEX.test(value)) fail("digest_mismatch"); }
function validId(value: unknown): void { if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity"); }
function timestamp(value: unknown): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_attempt"); }
function safeCode(value: string): string { return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : "proof_verification_failed"; }
function exact(value: object, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_proof"); }
function validateProvenance(values: readonly FactProvenance[]): void { for (const value of values) { const fact = copy(value); exact(fact, ["source", "issuer", "digest"]); if ((fact.source !== "host_asserted" && fact.source !== "trusted_issuer") || (fact.issuer !== undefined && typeof fact.issuer !== "string") || (fact.digest !== undefined && (typeof fact.digest !== "string" || !HEX.test(fact.digest)))) fail("invalid_proof"); } }
function fail(code: AuditAdapterErrorCode): never { throw new AuditAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
