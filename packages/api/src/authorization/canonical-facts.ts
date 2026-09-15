import { and, eq, gt, isNull } from "drizzle-orm";
import { validateCurrentPolicyDynamicFactsV2, type CurrentPolicyDynamicFactsV2, type CurrentPolicyRisk, type CurrentPolicyScope } from "@valet/engine/authorization";
import type { AppQueryable } from "../lib/drizzle.js";
import { canonicalApprovalResolutions, runtimeGrants } from "../schema/index.js";

export interface CanonicalFactQuery {
  organizationId: string;
  service: string;
  actionId: string;
  riskLevel: CurrentPolicyRisk;
  appliesIn: CurrentPolicyScope;
  scopeId: string;
  evaluationTimeMs: number;
  requestSubjectDigest?: string;
  originalDecisionDigest?: string;
}

/** Loads only facts relevant to one exact request and rejects unbounded sets. */
export async function loadCanonicalDynamicFacts(db: AppQueryable, query: CanonicalFactQuery): Promise<CurrentPolicyDynamicFactsV2> {
  const scope = query.appliesIn === "workflow"
    ? eq(runtimeGrants.workflowExecutionId, query.scopeId)
    : eq(runtimeGrants.sessionId, query.scopeId);
  const grants = await db.select().from(runtimeGrants).where(and(
    eq(runtimeGrants.orgId, query.organizationId), eq(runtimeGrants.policyKey, query.actionId), scope,
    isNull(runtimeGrants.revokedAt), gt(runtimeGrants.expiresAt, query.evaluationTimeMs),
  )).limit(9);
  if (grants.length > 8) throw new Error("Canonical authorization has more than eight relevant grants.");

  const approvalScope = query.appliesIn === "workflow"
    ? eq(canonicalApprovalResolutions.workflowExecutionId, query.scopeId)
    : query.appliesIn === "session"
      ? eq(canonicalApprovalResolutions.sessionId, query.scopeId)
      : and(eq(canonicalApprovalResolutions.scopeKind, query.appliesIn), eq(canonicalApprovalResolutions.scopeId, query.scopeId));
  const approvals = query.requestSubjectDigest && query.originalDecisionDigest
    ? await db.select().from(canonicalApprovalResolutions).where(and(
        eq(canonicalApprovalResolutions.orgId, query.organizationId),
        eq(canonicalApprovalResolutions.requestSubjectDigest, query.requestSubjectDigest),
        eq(canonicalApprovalResolutions.originalDecisionDigest, query.originalDecisionDigest),
        approvalScope, isNull(canonicalApprovalResolutions.revokedAt),
        gt(canonicalApprovalResolutions.expiresAt, query.evaluationTimeMs),
      )).limit(9)
    : [];
  if (approvals.length > 8) throw new Error("Canonical authorization has more than eight relevant approvals.");

  const facts: CurrentPolicyDynamicFactsV2 = {
    schemaVersion: 2,
    organizationId: query.organizationId,
    grants: grants.map((grant) => {
      if (!grant.service || !grant.actionId || !grant.riskLevel || !grant.expiresAt || !grant.sourceApprovalId) throw new Error("Canonical runtime grant is incomplete.");
      return [grant.id, grant.policyKey, grant.service, grant.actionId, grant.riskLevel, query.appliesIn, query.scopeId, grant.createdAt, grant.expiresAt, grant.revokedAt] as const;
    }),
    approvalBinding: approvals.length > 0 ? [query.requestSubjectDigest!, query.originalDecisionDigest!, query.appliesIn, query.scopeId] : null,
    approvals: approvals.map((approval) => [approval.resolutionId, approval.verdict, approval.resolvedAt, approval.expiresAt, 1] as const),
  };
  return validateCurrentPolicyDynamicFactsV2(facts, { ...query });
}

export async function persistApprovalResolution(db: AppQueryable, fact: typeof canonicalApprovalResolutions.$inferInsert): Promise<void> {
  await db.insert(canonicalApprovalResolutions).values(fact);
}
