import { eq } from "drizzle-orm";
import type { PolicyDecision } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, canonicalApprovalResolutions } from "../schema/index.js";

export async function persistCanonicalOneShotApproval(input: {
  db: AppDb; decision: PolicyDecision; resolutionId: string; organizationId: string; sessionId: string;
  approverId: string; resolvedAtMs: number; executionInputDigest: string;
}): Promise<void> {
  const canonical = input.decision.canonical;
  if (!canonical?.decisionId || !canonical.approvalRequirement || canonical.executionInputDigest !== input.executionInputDigest) throw new Error("Canonical approval is incomplete.");
  const original = (await input.db.select().from(authorizationDecisions).where(eq(authorizationDecisions.decisionId, canonical.decisionId)).limit(1))[0];
  const evidence = original?.evidence;
  if (!original || !evidence || original.orgId !== input.organizationId || original.effect !== "require_approval" || original.requestSubjectDigest !== canonical.requestSubjectDigest || original.inputDigest !== canonical.inputDigest || original.policyDigest !== canonical.policyDigest || original.sourceBundleDigest !== canonical.sourceBundleDigest || original.evaluatorEngineDigest !== canonical.engineDigest || evidence.decisionDigest !== canonical.decisionDigest) throw new Error("Canonical approval decision identity is invalid.");
  await input.db.insert(canonicalApprovalResolutions).values({
    resolutionId: input.resolutionId, approvalId: original.decisionId, gateId: input.resolutionId,
    orgId: original.orgId, requestSubjectDigest: original.requestSubjectDigest,
    originalDecisionDigest: evidence.decisionDigest, approverId: input.approverId, verdict: "approved",
    appliesIn: "session", sessionId: input.sessionId, resolvedAt: input.resolvedAtMs,
    expiresAt: canonical.approvalRequirement.expiresAtMs ?? input.resolvedAtMs + 72 * 60 * 60 * 1000,
    resolutionVersion: 1,
  }).onConflictDoNothing();
}
