import type { PolicyDecision } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { canonicalApprovalResolutions } from "../schema/index.js";

export async function persistCanonicalOneShotApproval(input: {
  db: AppDb; decision: PolicyDecision; resolutionId: string; organizationId: string; sessionId: string;
  approverId: string; resolvedAtMs: number;
}): Promise<void> {
  const canonical = input.decision.canonical;
  if (!canonical?.decisionId || !canonical.approvalRequirement) throw new Error("Canonical approval is incomplete.");
  await input.db.insert(canonicalApprovalResolutions).values({
    resolutionId: input.resolutionId, approvalId: canonical.decisionId, gateId: input.resolutionId,
    orgId: input.organizationId, requestSubjectDigest: canonical.requestSubjectDigest,
    originalDecisionDigest: canonical.decisionDigest, approverId: input.approverId, verdict: "approved",
    appliesIn: "session", sessionId: input.sessionId, resolvedAt: input.resolvedAtMs,
    expiresAt: canonical.approvalRequirement.expiresAtMs ?? input.resolvedAtMs + 72 * 60 * 60 * 1000,
    resolutionVersion: 1,
  }).onConflictDoNothing();
}
