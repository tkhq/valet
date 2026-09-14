import { and, eq } from "drizzle-orm";
import { authorizationSha256Hex, canonicalAuthorizationJson, decisionDigestOf, type CurrentPolicyDynamicFactsV2, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { DecisionResolution, PluginActionResult, PolicyDecision, PolicyExecutionSettlement, PolicyResolveInput, PolicyResolver } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, authorizationExecutionAttempts, canonicalApprovalResolutions, type AuthorizationDecisionRow } from "../schema/index.js";
import { adaptResolvedPluginCatalogAction } from "@valet/engine";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import type { ActionPluginByService } from "./canonical-policy-manager.js";
import {
  GATE_ACTION_ALWAYS_ALLOW,
  GATE_ACTION_APPROVE_SESSION,
  capAuditField,
  POLICY_AUDIT_FIELD_CAP,
  persistInvocationAudit,
  writeAlwaysAllowPolicy,
  writeSessionGrant,
} from "../policies/service.js";

export function canonicalInteractivePolicyResolver(opts: { db: AppDb; service: CanonicalAuthorizationService; plugins: ActionPluginByService; clock?: () => number }): PolicyResolver {
  const now = opts.clock ?? Date.now;
  const requestFor = async (input: PolicyResolveInput) => {
    if (!input.orgId || !input.userId || !input.queueItemId || !input.resumeKey || !input.owner) throw new Error("Canonical interactive authorization context is incomplete.");
    if (!opts.plugins.has(input.service)) throw new Error("Canonical interactive service is not registered.");
    if (!input.parameterProjection) throw new Error("Canonical interactive action has no safe-parameter projection.");
    const common = { service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, params: input.params, projection: input.parameterProjection, context: { userId: input.userId, orgId: input.orgId, sessionId: input.sessionId, threadId: input.threadId, owner: input.owner, queueItemId: input.queueItemId }, requestId: input.queueItemId, resumeKey: input.resumeKey, gateOrdinal: input.gateOrdinal ?? 0, evaluationTimeMs: now() };
    const initial = adaptResolvedPluginCatalogAction({ ...common, dynamicFacts: {} });
    const original = (await opts.db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.orgId, input.orgId), eq(authorizationDecisions.idempotencyKey, initial.request.idempotencyKey))).limit(1))[0];
    const approvalBindingContext = original?.effect === "require_approval" && original.evidence
      ? { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest }
      : undefined;
    const facts = await loadCanonicalDynamicFacts(opts.db, { organizationId: input.orgId, service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, appliesIn: "session", scopeId: input.sessionId, evaluationTimeMs: now(), ...approvalBindingContext });
    const post = adaptResolvedPluginCatalogAction({ ...common, dynamicFacts: { currentPolicy: facts }, ...(approvalBindingContext ? { approvalBindingContext } : {}) });
    if (!approvalBindingContext) return post.request;
    if (original.requestSubjectDigest !== initial.requestSubjectDigest) throw new Error("Canonical approval retry identity is invalid.");
    // A restart resolves before it receives the stored gate resolution. Replay
    // the persisted request until that resolution is durable.
    if (facts.approvals.length === 0) return original.evidence!.request;
    const invocationId = authorizationSha256Hex(canonicalAuthorizationJson({ original: post.request.subject.invocation.id, facts }));
    return { ...post.request, subject: { ...post.request.subject, invocation: { ...post.request.subject.invocation, id: invocationId } }, idempotencyKey: `${post.request.subject.invocation.type}:${invocationId}` };
  };
  return {
    async resolve(input) {
      const request = await requestFor(input);
      const envelope = await opts.service.authorize(request);
      const decisionId = canonicalDecisionId(request.subject.orgId, request.idempotencyKey);
      const persisted = await loadDecision(opts.db, decisionId);
      const currentPolicy = request.facts.currentPolicy as CurrentPolicyDynamicFactsV2 | undefined;
      const grants = currentPolicy?.grants.map((grant) => grant[0]) ?? [];
      return policyDecision(envelope, persisted, executionInputDigest(input), grants);
    },
    async reserveExecution(input, decision) {
      const identity = await executionIdentity(opts.db, decision, executionInputDigest(input));
      const attemptId = `attempt:${identity.decisionId.slice("decision:".length)}`;
      const inserted = await opts.db.insert(authorizationExecutionAttempts).values({ attemptId, decisionId: identity.decisionId, outcome: "started", targetIdempotencyKey: identity.idempotencyKey, externalOperationIds: [], startedAt: now(), createdAt: now() }).onConflictDoNothing().returning({ attemptId: authorizationExecutionAttempts.attemptId });
      if (inserted[0]) return { kind: "execute", attemptId };
      return replayAttempt(await loadAttempt(opts.db, attemptId), identity.decisionId, identity.idempotencyKey);
    },
    async completeExecution(input, decision, attemptId, settlement) {
      const identity = await executionIdentity(opts.db, decision, executionInputDigest(input));
      const attempt = await loadAttempt(opts.db, attemptId);
      assertAttemptIdentity(attempt, identity.decisionId, identity.idempotencyKey);
      const persisted = boundedSettlement(settlement);
      const updated = await opts.db.update(authorizationExecutionAttempts).set(persisted.outcome === "completed"
        ? { outcome: "completed", redactedResult: persisted.result, redactedError: null, finishedAt: now() }
        : { outcome: "failed", redactedResult: persisted.result ?? null, redactedError: persisted.error, finishedAt: now() })
        .where(and(eq(authorizationExecutionAttempts.attemptId, attemptId), eq(authorizationExecutionAttempts.outcome, "started")))
        .returning({ attemptId: authorizationExecutionAttempts.attemptId });
      if (!updated[0]) return settlementFromAttempt(await loadAttempt(opts.db, attemptId), identity.decisionId, identity.idempotencyKey);
      return persisted;
    },
    async onResolution(input, decision, resolution) {
      const c = decision.canonical;
      if (!c?.approvalRequirement || !input.orgId) throw new Error("Canonical approval is incomplete.");
      const original = await loadDecision(opts.db, c.decisionId);
      assertOriginalApproval(input, c, original);
      if (resolution.actionId === "deny") return;
      if (resolution.actionId === GATE_ACTION_APPROVE_SESSION) {
        const sourceApprovalId = `resolution:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}`;
        await writeSessionGrant(opts.db, input.sessionId, { orgId: input.orgId, service: input.service, actionId: input.actionId, riskLevel: input.riskLevel, sourceApprovalId, expiresAt: resolution.resolvedAt + 72 * 60 * 60 * 1000, grantedBy: resolution.resolvedBy, now: resolution.resolvedAt });
      }
      if (resolution.actionId === GATE_ACTION_ALWAYS_ALLOW) {
        await opts.service.mutateAndActivate(input.orgId, { actorId: resolution.resolvedBy, operation: "always_allow", idempotencyKey: `always_allow:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}` }, (tx) => writeAlwaysAllowPolicy(tx, { orgId: input.orgId!, actionId: input.actionId, grantedBy: resolution.resolvedBy, now: resolution.resolvedAt }));
      }
      if (!["approve", GATE_ACTION_APPROVE_SESSION, GATE_ACTION_ALWAYS_ALLOW].includes(resolution.actionId ?? "")) throw new Error("Canonical approval was not approved.");
      const requirement = c.approvalRequirement;
      const resolutionId = `resolution:${input.queueItemId}:${resolution.gateOrdinal ?? input.gateOrdinal ?? 0}`;
      await opts.db.insert(canonicalApprovalResolutions).values({ resolutionId, approvalId: original.decisionId, gateId: resolutionId, orgId: original.orgId, requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence!.decisionDigest, approverId: resolution.resolvedBy, verdict: "approved", appliesIn: "session", sessionId: input.sessionId, resolvedAt: resolution.resolvedAt, expiresAt: requirement.expiresAtMs ?? resolution.resolvedAt + 72 * 60 * 60 * 1000, resolutionVersion: 1 }).onConflictDoNothing();
    },
    async onInvocation(record) {
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

async function loadDecision(db: AppDb, decisionId: string | undefined): Promise<AuthorizationDecisionRow> {
  if (!decisionId) throw new Error("Canonical approval decision identity is incomplete.");
  const row = (await db.select().from(authorizationDecisions).where(eq(authorizationDecisions.decisionId, decisionId)).limit(1))[0];
  if (!row?.evidence) throw new Error("Canonical approval decision identity is invalid.");
  return row;
}

function decisionMatchesCanonical(row: AuthorizationDecisionRow, canonical: NonNullable<PolicyDecision["canonical"]>): boolean {
  return row.requestSubjectDigest === canonical.requestSubjectDigest && row.inputDigest === canonical.inputDigest &&
    row.policyDigest === canonical.policyDigest && row.sourceBundleDigest === canonical.sourceBundleDigest &&
    row.evaluatorKind === canonical.evaluatorKind && row.evaluatorEngineDigest === canonical.engineDigest &&
    row.evidence?.decisionDigest === canonical.decisionDigest && row.evidence.profileDigest === canonical.profileDigest &&
    row.evidence.interpreterDigest === canonical.interpreterDigest && row.evidence.contractDigest === canonical.contractDigest;
}

function assertOriginalApproval(input: PolicyResolveInput, canonical: NonNullable<PolicyDecision["canonical"]>, row: AuthorizationDecisionRow): void {
  const exact = canonical.executionInputDigest === executionInputDigest(input) && row.orgId === input.orgId && row.effect === "require_approval" && decisionMatchesCanonical(row, canonical);
  if (!exact) throw new Error("Canonical approval decision identity is invalid.");
}

const INDETERMINATE_EXECUTION = "indeterminate_execution: the action may have run. Do not retry automatically.";

type AttemptRow = typeof authorizationExecutionAttempts.$inferSelect;

function executionInputDigest(input: PolicyResolveInput): string {
  return authorizationSha256Hex(canonicalAuthorizationJson(input));
}

async function executionIdentity(db: AppDb, decision: PolicyDecision, inputDigest?: string): Promise<{ decisionId: string; idempotencyKey: string }> {
  const canonical = decision.canonical;
  if (!canonical?.decisionId) throw new Error("Canonical interactive execution has no durable decision.");
  const inputMatches = inputDigest === undefined || canonical.executionInputDigest === inputDigest;
  const row = (await db.select().from(authorizationDecisions).where(eq(authorizationDecisions.decisionId, canonical.decisionId)).limit(1))[0];
  if (!inputMatches || !row || row.effect !== "allow" || !decisionMatchesCanonical(row, canonical)) {
    throw new Error("Canonical interactive execution decision identity is invalid.");
  }
  return { decisionId: row.decisionId, idempotencyKey: row.idempotencyKey };
}

async function loadAttempt(db: AppDb, attemptId: string): Promise<AttemptRow | undefined> {
  return (await db.select().from(authorizationExecutionAttempts).where(eq(authorizationExecutionAttempts.attemptId, attemptId)).limit(1))[0];
}

function assertAttemptIdentity(attempt: AttemptRow | undefined, decisionId: string, idempotencyKey: string): asserts attempt is AttemptRow {
  if (!attempt || attempt.decisionId !== decisionId || attempt.targetIdempotencyKey !== idempotencyKey) throw new Error("Canonical interactive execution attempt identity is invalid.");
}

function replayAttempt(attempt: AttemptRow | undefined, decisionId: string, idempotencyKey: string): Awaited<ReturnType<NonNullable<PolicyResolver["reserveExecution"]>>> {
  assertAttemptIdentity(attempt, decisionId, idempotencyKey);
  if (attempt.outcome === "completed") return { kind: "completed", result: pluginResult(attempt.redactedResult) };
  if (attempt.outcome === "failed" && attempt.redactedError) return {
    kind: "failed",
    error: attempt.redactedError,
    ...(attempt.redactedResult === null ? {} : { result: pluginResult(attempt.redactedResult) }),
  };
  return { kind: "indeterminate", error: INDETERMINATE_EXECUTION };
}

function settlementFromAttempt(attempt: AttemptRow | undefined, decisionId: string, idempotencyKey: string): PolicyExecutionSettlement {
  const replay = replayAttempt(attempt, decisionId, idempotencyKey);
  if (replay.kind === "completed") return { outcome: "completed", result: replay.result };
  if (replay.kind === "failed") return { outcome: "failed", error: replay.error, ...(replay.result === undefined ? {} : { result: replay.result }) };
  return { outcome: "failed", error: INDETERMINATE_EXECUTION };
}

function pluginResult(value: unknown): PluginActionResult {
  if (!value || typeof value !== "object" || !("success" in value) || (value.success !== true && value.success !== false)) throw new Error("Canonical interactive execution result is invalid.");
  const row = value as Record<string, unknown>;
  return { success: row.success === true, ...(row.data !== undefined ? { data: row.data } : {}), ...(typeof row.error === "string" ? { error: row.error } : {}) };
}

function boundedSettlement(settlement: PolicyExecutionSettlement): PolicyExecutionSettlement {
  const result = settlement.outcome === "completed" ? pluginResult(settlement.result) : settlement.result === undefined ? undefined : pluginResult(settlement.result);
  const capped = result === undefined ? undefined : capAuditField(result);
  const replayResult = capped?.truncated
    ? { success: result!.success, ...(result!.error === undefined ? {} : { error: result!.error.slice(0, POLICY_AUDIT_FIELD_CAP) }), data: capped.value } satisfies PluginActionResult
    : result;
  if (settlement.outcome === "failed") return { outcome: "failed", error: settlement.error.slice(0, POLICY_AUDIT_FIELD_CAP), ...(replayResult === undefined ? {} : { result: replayResult }) };
  return { outcome: "completed", result: replayResult! };
}

function policyDecision(envelope: PolicyDecisionEnvelope, persisted: AuthorizationDecisionRow, executionInputDigest: string, grantIds: readonly string[] = []): PolicyDecision {
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
  ] } : {}), canonical: { reasonCode: d.reasonCode, obligations: d.obligations, redactions: d.redactions, ...(d.approvalRequirement ? { approvalRequirement: d.approvalRequirement } : {}), requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, profileDigest: persisted.evidence!.profileDigest, interpreterDigest: persisted.evidence!.interpreterDigest, contractDigest: persisted.evidence!.contractDigest, decisionDigest: decisionDigestOf(d), executionInputDigest, decisionId: persisted.decisionId } };
}
