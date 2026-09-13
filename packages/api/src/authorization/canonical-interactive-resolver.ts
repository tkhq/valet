import { and, eq, isNull } from "drizzle-orm";
import { authorizationSha256Hex, canonicalAuthorizationJson, decisionDigestOf, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { DecisionResolution, PolicyDecision, PolicyResolveInput, PolicyResolver } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, authorizationExecutionAttempts, canonicalApprovalResolutions } from "../schema/index.js";
import { adaptPluginCatalogAction } from "@valet/engine";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { actionProjection } from "./action-projections.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import type { ActionPluginByService } from "./canonical-policy-manager.js";

export function canonicalInteractivePolicyResolver(opts: { db: AppDb; service: CanonicalAuthorizationService; plugins: ActionPluginByService; clock?: () => number }): PolicyResolver {
  const now = opts.clock ?? Date.now;
  const requestFor = async (input: PolicyResolveInput) => {
    if (!input.orgId || !input.userId || !input.queueItemId || !input.resumeKey || !input.owner) throw new Error("Canonical interactive authorization context is incomplete.");
    const entry = opts.plugins.get(input.service);
    const action = entry?.actionPlugin.actions.find((item) => (item.id.includes(".") ? item.id : `${input.service}.${item.id}`) === input.actionId);
    if (!entry || !action || !input.params) throw new Error("Canonical interactive action is not statically registered.");
    const common = { plugin: entry.actionPlugin, action, params: input.params, projection: actionProjection(input.actionId), context: { userId: input.userId, orgId: input.orgId, sessionId: input.sessionId, threadId: input.threadId, owner: input.owner, queueItemId: input.queueItemId }, requestId: input.queueItemId, resumeKey: input.resumeKey, gateOrdinal: input.gateOrdinal ?? 0, evaluationTimeMs: now() };
    const initial = adaptPluginCatalogAction({ ...common, dynamicFacts: {} });
    const original = (await opts.db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.orgId, input.orgId), eq(authorizationDecisions.idempotencyKey, initial.request.idempotencyKey))).limit(1))[0];
    if (!original || original.effect !== "require_approval" || !original.evidence) return initial.request;
    const approval = (await opts.db.select().from(canonicalApprovalResolutions).where(and(eq(canonicalApprovalResolutions.orgId, input.orgId), eq(canonicalApprovalResolutions.requestSubjectDigest, original.requestSubjectDigest), isNull(canonicalApprovalResolutions.revokedAt))).limit(1))[0];
    if (!approval) return initial.request;
    const facts = await loadCanonicalDynamicFacts(opts.db, { organizationId: input.orgId, service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, appliesIn: "session", scopeId: input.sessionId, evaluationTimeMs: now(), requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest });
    const post = adaptPluginCatalogAction({ ...common, dynamicFacts: { currentPolicy: facts }, approvalBindingContext: { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest } });
    const invocationId = authorizationSha256Hex(canonicalAuthorizationJson({ original: post.request.subject.invocation.id, resolutionId: approval.resolutionId }));
    return { ...post.request, subject: { ...post.request.subject, invocation: { ...post.request.subject.invocation, id: invocationId } }, idempotencyKey: `${post.request.subject.invocation.type}:${invocationId}` };
  };
  return {
    async resolve(input) {
      const request = await requestFor(input);
      const envelope = await opts.service.authorize(request);
      const decisionId = canonicalDecisionId(request.subject.orgId, request.idempotencyKey);
      let attemptId: string | undefined;
      if (envelope.decision.effect === "allow") {
        attemptId = `attempt:${decisionId.slice("decision:".length)}`;
        const inserted = await opts.db.insert(authorizationExecutionAttempts).values({ attemptId, decisionId, outcome: "started", targetIdempotencyKey: request.idempotencyKey, externalOperationIds: [], startedAt: now(), createdAt: now() }).onConflictDoNothing().returning({ attemptId: authorizationExecutionAttempts.attemptId });
        if (!inserted[0]) throw new Error("Canonical interactive execution attempt is already reserved.");
      }
      return policyDecision(envelope, decisionId, attemptId);
    },
    async onResolution(input, decision, resolution) {
      const c = decision.canonical;
      if (resolution.actionId !== "approve" || !c?.approvalRequirement || !input.orgId) throw new Error("Canonical approval was not approved or is incomplete.");
      const requirement = c.approvalRequirement;
      const scopeId = input.sessionId;
      const resolutionId = `resolution:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}`;
      await opts.db.insert(canonicalApprovalResolutions).values({ resolutionId, approvalId: c.decisionId!, gateId: resolutionId, orgId: input.orgId, requestSubjectDigest: c.requestSubjectDigest, originalDecisionDigest: c.decisionDigest, approverId: resolution.resolvedBy, verdict: "approved", appliesIn: "session", sessionId: scopeId, resolvedAt: resolution.resolvedAt, expiresAt: requirement.expiresAtMs ?? resolution.resolvedAt + 72 * 60 * 60 * 1000, resolutionVersion: 1 }).onConflictDoNothing();
    },
    async onInvocation(record) {
      if (!record.canonicalExecutionAttemptId) return;
      const outcome = record.status === "completed" ? "completed" : record.status === "error" ? "failed" : "cancelled";
      await opts.db.update(authorizationExecutionAttempts).set({ outcome, redactedResult: record.status === "completed" ? { completed: true } : null, redactedError: record.status === "error" ? "Action execution failed." : null, finishedAt: now() }).where(eq(authorizationExecutionAttempts.attemptId, record.canonicalExecutionAttemptId));
    },
  };
}

function policyDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionAttemptId?: string): PolicyDecision {
  const d = envelope.decision;
  return { mode: d.effect, provenance: { baseMode: d.effect, source: "canonical_service" }, canonical: { reasonCode: d.reasonCode, obligations: d.obligations, redactions: d.redactions, ...(d.approvalRequirement ? { approvalRequirement: d.approvalRequirement } : {}), requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(d), decisionId, ...(executionAttemptId ? { executionAttemptId } : {}) } };
}
