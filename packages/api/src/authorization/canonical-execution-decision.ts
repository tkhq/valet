import type { PolicyDecision } from "@valet/engine";
import { decisionDigestOf, type PolicyDecisionEnvelope } from "@valet/engine/authorization";

export function canonicalExecutionDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionInputDigest: string): PolicyDecision {
  return { mode: envelope.decision.effect, provenance: { baseMode: envelope.decision.effect, source: "canonical_service" }, canonical: {
    reasonCode: envelope.decision.reasonCode, obligations: envelope.decision.obligations, redactions: envelope.decision.redactions,
    ...(envelope.decision.approvalRequirement ? { approvalRequirement: envelope.decision.approvalRequirement } : {}),
    requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest,
    policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind,
    engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(envelope.decision), executionInputDigest, decisionId,
  } };
}
