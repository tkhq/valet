import { and, eq } from "drizzle-orm";
import { authorizationSha256Hex, canonicalAuthorizationJson, decisionDigestOf, type CurrentPolicyDynamicFactsV2, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { DecisionResolution, PolicyDecision, PolicyResolveInput, PolicyResolver } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, authorizationExecutionAttempts, canonicalApprovalResolutions } from "../schema/index.js";
import { adaptPluginCatalogAction } from "@valet/engine";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { actionProjection } from "./action-projections.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import type { ActionPluginByService } from "./canonical-policy-manager.js";
import {
  GATE_ACTION_ALWAYS_ALLOW,
  GATE_ACTION_APPROVE_SESSION,
  persistInvocationAudit,
  writeAlwaysAllowPolicy,
  writeSessionGrant,
} from "../policies/service.js";

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
    const approvalBindingContext = original?.effect === "require_approval" && original.evidence
      ? { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest }
      : undefined;
    const facts = await loadCanonicalDynamicFacts(opts.db, { organizationId: input.orgId, service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, appliesIn: "session", scopeId: input.sessionId, evaluationTimeMs: now(), ...approvalBindingContext });
    const post = adaptPluginCatalogAction({ ...common, dynamicFacts: { currentPolicy: facts }, ...(approvalBindingContext ? { approvalBindingContext } : {}) });
    if (!approvalBindingContext) return post.request;
    const invocationId = authorizationSha256Hex(canonicalAuthorizationJson({ original: post.request.subject.invocation.id, facts }));
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
      const currentPolicy = request.facts.currentPolicy as CurrentPolicyDynamicFactsV2 | undefined;
      const grants = currentPolicy?.grants.map((grant) => grant[0]) ?? [];
      return policyDecision(envelope, decisionId, attemptId, grants);
    },
    async onResolution(input, decision, resolution) {
      const c = decision.canonical;
      if (!c?.approvalRequirement || !input.orgId) throw new Error("Canonical approval is incomplete.");
      if (resolution.actionId === "deny") return;
      if (resolution.actionId === GATE_ACTION_APPROVE_SESSION) {
        const sourceApprovalId = `resolution:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}`;
        await writeSessionGrant(opts.db, input.sessionId, { orgId: input.orgId, service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, sourceApprovalId, expiresAt: resolution.resolvedAt + 72 * 60 * 60 * 1000, grantedBy: resolution.resolvedBy, now: resolution.resolvedAt });
        return;
      }
      if (resolution.actionId === GATE_ACTION_ALWAYS_ALLOW) {
        await opts.service.mutateAndActivate(input.orgId, { actorId: resolution.resolvedBy, operation: "always_allow", idempotencyKey: `always_allow:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}` }, (tx) => writeAlwaysAllowPolicy(tx, { orgId: input.orgId!, actionId: input.actionId, grantedBy: resolution.resolvedBy, now: resolution.resolvedAt }));
        return;
      }
      if (resolution.actionId !== "approve") throw new Error("Canonical approval was not approved.");
      const requirement = c.approvalRequirement;
      const resolutionId = `resolution:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}`;
      await opts.db.insert(canonicalApprovalResolutions).values({ resolutionId, approvalId: c.decisionId!, gateId: resolutionId, orgId: input.orgId, requestSubjectDigest: c.requestSubjectDigest, originalDecisionDigest: c.decisionDigest, approverId: resolution.resolvedBy, verdict: "approved", appliesIn: "session", sessionId: input.sessionId, resolvedAt: resolution.resolvedAt, expiresAt: requirement.expiresAtMs ?? resolution.resolvedAt + 72 * 60 * 60 * 1000, resolutionVersion: 1 }).onConflictDoNothing();
    },
    async onInvocation(record) {
      if (record.canonicalExecutionAttemptId) {
        const outcome = record.status === "completed" ? "completed" : record.status === "error" ? "failed" : "cancelled";
        await opts.db.update(authorizationExecutionAttempts).set({ outcome, redactedResult: record.status === "completed" ? { completed: true } : null, redactedError: record.status === "error" ? "Action execution failed." : null, finishedAt: now() }).where(eq(authorizationExecutionAttempts.attemptId, record.canonicalExecutionAttemptId));
      }
      const invocationId = `canonical:${authorizationSha256Hex(canonicalAuthorizationJson({ sessionId: record.sessionId, queueItemId: record.queueItemId, resumeKey: record.resumeKey, gateOrdinal: record.gateOrdinal ?? -1 }))}`;
      await persistInvocationAudit(opts.db, {
        invocationId,
        service: record.service,
        actionId: record.actionId,
        riskLevel: record.riskLevel,
        resolvedMode: record.resolvedMode,
        baseMode: record.provenance.baseMode,
        matchedPolicyId: record.provenance.matchedPolicyId,
        matchedGrantId: record.provenance.matchedGrantId,
        matchedOverrideId: record.provenance.matchedOverrideId,
        status: record.status,
        sessionId: record.sessionId,
        userId: record.userId,
        orgId: record.orgId,
        params: record.params,
        result: record.result,
        error: record.error,
        durationMs: record.durationMs,
        startedAt: now(),
        createdAt: now(),
      });
    },
  };
}

function policyDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionAttemptId?: string, grantIds: readonly string[] = []): PolicyDecision {
  const d = envelope.decision;
  const matchedGrantId = d.matchedRuleIds.find((id) => grantIds.includes(id));
  const matchedId = d.matchedRuleIds.find((id) => id !== matchedGrantId);
  const source = d.reasonCode === "organization_policy" ? "org_policy"
    : d.reasonCode === "team_policy" ? "team_policy"
      : d.reasonCode === "dynamic_grant" ? "runtime_grant"
        : d.reasonCode === "personal_override" ? "override"
          : d.reasonCode === "plugin_default" ? "plugin_default"
            : d.reasonCode === "risk_default" ? "risk_default"
              : "canonical_service";
  const provenance = {
    baseMode: d.effect,
    source,
    ...(source === "org_policy" || source === "team_policy" || source === "runtime_grant" && matchedId && !matchedId.startsWith("risk:") && !matchedId.startsWith("plugin:") && !matchedId.startsWith("bundle:") ? { matchedPolicyId: matchedId } : {}),
    ...(source === "runtime_grant" && matchedGrantId ? { matchedGrantId } : {}),
    ...(source === "override" ? { matchedOverrideId: matchedId } : {}),
  } satisfies PolicyDecision["provenance"];
  return { mode: d.effect, provenance, ...(d.effect === "require_approval" ? { extraGateActions: [
    { id: GATE_ACTION_APPROVE_SESSION, label: "Allow for this session", style: "primary" as const, approves: true },
    { id: GATE_ACTION_ALWAYS_ALLOW, label: "Always allow", style: "primary" as const, approves: true },
  ] } : {}), canonical: { reasonCode: d.reasonCode, obligations: d.obligations, redactions: d.redactions, ...(d.approvalRequirement ? { approvalRequirement: d.approvalRequirement } : {}), requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(d), decisionId, ...(executionAttemptId ? { executionAttemptId } : {}) } };
}
