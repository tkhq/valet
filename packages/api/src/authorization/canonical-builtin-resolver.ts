import { and, eq } from "drizzle-orm";
import { adaptInteractiveBuiltin, projectBuiltinArguments, authorizationSha256Hex, canonicalAuthorizationJson, decisionDigestOf, type AuthorizationRequest, type CurrentPolicyDynamicFactsV2, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { BuiltinPolicyResolveInput, BuiltinPolicyResolver, DecisionResolution, PolicyDecision, ToolResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions } from "../schema/index.js";
import { persistInvocationAudit } from "../policies/service.js";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { loadCanonicalDynamicFacts } from "./canonical-facts.js";
import { completeCanonicalExecution, reserveCanonicalExecution } from "./canonical-execution-lifecycle.js";
import { persistCanonicalOneShotApproval } from "./canonical-approval-lifecycle.js";

const INDETERMINATE = "indeterminate_execution: the tool may have run. Do not retry automatically.";
const RESULT_CAP = 64_000;


export function canonicalBuiltinPolicyResolver(opts: { db: AppDb; service: CanonicalAuthorizationService; clock?: () => number }): BuiltinPolicyResolver {
  const now = opts.clock ?? Date.now;
  const requestFor = async (input: BuiltinPolicyResolveInput): Promise<AuthorizationRequest> => {
    const common = { schemaVersion: 1 as const, organizationId: input.orgId, actor: { type: "user" as const, id: input.userId }, owner: input.owner, requestId: input.queueItemId, sessionId: input.sessionId, threadId: input.threadId, queueItemId: input.queueItemId, toolCallId: input.toolCallId, gateOrdinal: input.gateOrdinal, descriptor: input.descriptor, arguments: input.args, evaluationTimeMs: now() };
    const initial = adaptInteractiveBuiltin(common);
    const original = await decisionRow(opts.db, input.orgId, initial.idempotencyKey);
    const binding = original?.effect === "require_approval" && original.evidence ? { requestSubjectDigest: original.requestSubjectDigest, originalDecisionDigest: original.evidence.decisionDigest } : undefined;
    const facts = await loadCanonicalDynamicFacts(opts.db, { organizationId: input.orgId, service: "builtin", actionId: input.descriptor.actionId, riskLevel: input.descriptor.riskLevel, appliesIn: "session", scopeId: input.sessionId, evaluationTimeMs: now(), ...binding });
    const request = adaptInteractiveBuiltin({ ...common, facts: { currentPolicy: facts } });
    if (!binding) return request;
    const id = authorizationSha256Hex(canonicalAuthorizationJson({ invocation: request.subject.invocation.id, facts }));
    return { ...request, subject: { ...request.subject, invocation: { ...request.subject.invocation, id } }, idempotencyKey: `interactive:${id}` };
  };
  const identity = async (input: BuiltinPolicyResolveInput, decision: PolicyDecision) => {
    const canonical = decision.canonical;
    if (!canonical?.decisionId || canonical.executionInputDigest !== executionDigest(input)) throw new Error("Canonical built-in execution decision identity is invalid.");
    const row = (await opts.db.select().from(authorizationDecisions).where(eq(authorizationDecisions.decisionId, canonical.decisionId)).limit(1))[0];
    if (!row || row.effect !== "allow" || row.requestSubjectDigest !== canonical.requestSubjectDigest || row.inputDigest !== canonical.inputDigest || row.evidence?.decisionDigest !== canonical.decisionDigest) throw new Error("Canonical built-in execution decision identity is invalid.");
    return row;
  };
  return {
    async resolve(input) {
      const request = await requestFor(input);
      const envelope = await opts.service.authorize(request);
      return asDecision(envelope, canonicalDecisionId(input.orgId, request.idempotencyKey), executionDigest(input), (request.facts.currentPolicy as CurrentPolicyDynamicFactsV2 | undefined)?.grants.map((grant) => grant[0]) ?? []);
    },
    async onResolution(input, decision, resolution) {
      if (resolution.actionId !== "approve" || !decision.canonical?.approvalRequirement) throw new Error("Canonical built-in approval was not approved.");
      const resolutionId = `resolution:${input.queueItemId}:${input.toolCallId}:${resolution.gateOrdinal ?? input.gateOrdinal}`;
      await persistCanonicalOneShotApproval({ db: opts.db, decision, resolutionId, organizationId: input.orgId, sessionId: input.sessionId, approverId: resolution.resolvedBy, resolvedAtMs: resolution.resolvedAt });
    },
    async reserveExecution(input, decision) {
      return reserveCanonicalExecution(opts.db, decision, executionDigest(input), storedResult, now);
    },
    async completeExecution(input, decision, attemptId, settlement) {
      return completeCanonicalExecution(opts.db, decision, executionDigest(input), attemptId, settlement, (value) => boundedSettlement(input, value), storedResult, now);
    },
    async onInvocation(record) {
      const invocationId = `canonical-builtin:${authorizationSha256Hex(canonicalAuthorizationJson({ sessionId: record.sessionId, queueItemId: record.queueItemId, resumeKey: record.resumeKey, gateOrdinal: record.gateOrdinal ?? -1 }))}`;
      await persistInvocationAudit(opts.db, { invocationId, service: record.service, actionId: record.actionId, riskLevel: record.riskLevel, resolvedMode: record.resolvedMode, baseMode: record.provenance.baseMode, matchedPolicyId: record.provenance.matchedPolicyId, matchedGrantId: record.provenance.matchedGrantId, matchedOverrideId: record.provenance.matchedOverrideId, status: record.status, sessionId: record.sessionId, userId: record.userId, orgId: record.orgId, params: record.params, result: record.result, error: record.error, durationMs: record.durationMs, startedAt: now(), createdAt: now() });
    },
  };
}

function executionDigest(input: BuiltinPolicyResolveInput): string { return authorizationSha256Hex(canonicalAuthorizationJson({ descriptor: input.descriptor, projection: input.descriptor.projection, args: projectBuiltinArguments(input.args, input.descriptor.projection.pointers), orgId: input.orgId, userId: input.userId, owner: input.owner, sessionId: input.sessionId, threadId: input.threadId, queueItemId: input.queueItemId, toolCallId: input.toolCallId, gateOrdinal: input.gateOrdinal })); }
function asDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionInputDigest: string, grants: readonly string[]): PolicyDecision {
  const d = envelope.decision, matchedGrantId = d.matchedRuleIds.find((id) => grants.includes(id));
  return { mode: d.effect, provenance: { baseMode: d.effect, source: d.reasonCode === "dynamic_grant" ? "runtime_grant" : d.reasonCode === "risk_default" ? "risk_default" : "canonical_service", ...(matchedGrantId ? { matchedGrantId } : {}) }, canonical: { reasonCode: d.reasonCode, obligations: d.obligations, redactions: d.redactions, ...(d.approvalRequirement ? { approvalRequirement: d.approvalRequirement } : {}), requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest, policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind, engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(d), executionInputDigest, decisionId } };
}
async function decisionRow(db: AppDb, orgId: string, key: string) { return (await db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.orgId, orgId), eq(authorizationDecisions.idempotencyKey, key))).limit(1))[0]; }
function storedResult(value: unknown): ToolResult { const row = value as Record<string, unknown>; if (!row || row.code !== "completed_output_unavailable") throw new Error("Stored built-in result is invalid."); return { text: "Tool completed previously, but its content-bearing output is unavailable.", code: "completed_output_unavailable", ok: false }; }
function boundedSettlement(input: BuiltinPolicyResolveInput, settlement: { outcome: "completed"; result: ToolResult } | { outcome: "failed"; error: string; result?: ToolResult }) {
  if (input.descriptor.replay.result !== "output_unavailable") throw new Error("Built-in replay policy is unsupported.");
  const result = settlement.result ? boundedResult(settlement.result) : undefined;
  return settlement.outcome === "completed" ? { outcome: "completed" as const, result: result! } : { outcome: "failed" as const, error: settlement.error.slice(0, RESULT_CAP), ...(result ? { result } : {}) };
}
function boundedResult(_result: ToolResult): ToolResult { return { text: "", code: "completed_output_unavailable", ok: false }; }
