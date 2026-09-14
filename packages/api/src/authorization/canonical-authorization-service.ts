import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ApprovalMode, RiskLevel } from "@valet/engine";
import { adaptInteractiveAction, adaptWorkflowAction, assertEnvelope, buildActionObligationPlan, canonicalAuthorizationJson, decisionDigestOf, obligationDigestOf, requestSubjectDigest, type AuthorizationRequest, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { actionProjection } from "./action-projections.js";
import type { AppDb, AppTx } from "../lib/drizzle.js";
import { authorizationDecisions, type AuthorizationDecisionRow } from "../schema/index.js";
import { buildDecisionAuditPlan } from "./action-audit.js";
import type { AuthorizationService } from "./contracts.js";
import { LocalValetEvaluator } from "./evaluators/local-valet.js";
import type { CanonicalPolicyBundleManager, CanonicalPolicyMutationContext } from "./canonical-policy-manager.js";

export function canonicalDecisionId(orgId: string, idempotencyKey: string): string {
  return `decision:${createHash("sha256").update(`${orgId}\0${idempotencyKey}`).digest("hex")}`;
}

export class CanonicalAuthorizationService implements AuthorizationService {
  private constructor(
    private readonly manager: CanonicalPolicyBundleManager,
    private readonly db: AppDb,
    private readonly evaluator: LocalValetEvaluator,
    private readonly evidence: { profileDigest: string; interpreterDigest: string; contractDigest: string },
    private readonly now: () => number,
  ) {}

  static async create(manager: CanonicalPolicyBundleManager, now: () => number = Date.now): Promise<CanonicalAuthorizationService> {
    const identity = await manager.runtime.identity();
    const digest = (value: unknown) => createHash("sha256").update(canonicalAuthorizationJson(value)).digest("hex");
    return new CanonicalAuthorizationService(manager, manager.db, await LocalValetEvaluator.create(manager.host, manager.runtime), {
      profileDigest: digest({ capabilityProfileVersion: identity.capabilityProfileVersion, maxWallTimeMs: identity.maxWallTimeMs, maxEngineMemoryBytes: identity.maxEngineMemoryBytes }),
      interpreterDigest: digest({ name: identity.interpreterName, version: identity.interpreterVersion, revision: identity.interpreterRevision, regoVersion: identity.regoVersion }),
      contractDigest: digest({ contractVersion: identity.contractVersion }),
    }, now);
  }

  async mutateAndActivate<T>(organizationId: string, audit: { actorId: string; operation: string; idempotencyKey: string }, mutate: (tx: AppTx, context: CanonicalPolicyMutationContext) => Promise<T>): Promise<T> {
    return this.manager.mutateAndActivate(organizationId, audit, mutate);
  }

  async preview(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> {
    const envelope = assertEnvelope(request, await this.evaluator.evaluate(request));
    buildActionObligationPlan(envelope.decision);
    return envelope;
  }

  async validateOverrideBounds(orgId: string, userId: string, target: { service?: string; actionId?: string; riskLevel?: RiskLevel }, mode: ApprovalMode, activeIdentity: { sourceBundleDigest: string; policyDigest: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (mode !== "allow") return { ok: true };
    const catalog = [...this.manager.plugins.values()].flatMap(({ actionPlugin }) => actionPlugin.actions.map((action) => ({
      service: actionPlugin.service,
      actionId: action.id.includes(".") ? action.id : `${actionPlugin.service}.${action.id}`,
      riskLevel: action.riskLevel,
      parameterProjection: actionProjection(actionPlugin, action),
    })));
    let actions = target.actionId ? catalog.filter((action) => action.actionId === target.actionId)
      : target.service ? catalog.filter((action) => action.service === target.service)
      : catalog.filter((action) => action.riskLevel === target.riskLevel);
    if (target.actionId && actions.length === 0) return { ok: false, error: `cannot set override mode "allow": action "${target.actionId}" is not in the plugin catalog and cannot be verified against org policy` };
    if (actions.length === 0 && target.service) actions = (["low", "medium", "high", "critical"] as const).map((riskLevel) => ({ service: target.service!, actionId: `${target.service}.override_bounds`, riskLevel, parameterProjection: { schemaVersion: 1, mode: "all_safe" } as const }));
    if (target.riskLevel) {
      const services = [...this.manager.plugins.keys()];
      actions.push(...services.filter((service) => !actions.some((action) => action.service === service)).map((service) => ({ service, actionId: `${service}.override_bounds`, riskLevel: target.riskLevel!, parameterProjection: { schemaVersion: 1, mode: "all_safe" } as const })));
    }
    const now = this.now();
    for (const action of actions) for (const appliesIn of ["session", "workflow"] as const) {
      const requestId = createHash("sha256").update(canonicalAuthorizationJson({ orgId, userId, target, action, appliesIn, now })).digest("hex");
      const parameterProjection = action.actionId.endsWith(".override_bounds") ? { schemaVersion: 1, mode: "all_safe" } as const : action.parameterProjection;
      const common = { ...action, catalogActionId: action.actionId, sourcePluginService: action.service, sourceActionId: action.actionId, sourceToolId: "override_bounds", parameters: {}, parameterProjection };
      const adapted = appliesIn === "session"
        ? adaptInteractiveAction({ schemaVersion: 1, organizationId: orgId, actor: { type: "user", id: userId }, owner: { type: "user", id: userId }, requestId, sessionId: `override:${requestId}`, threadId: requestId, queueItemId: requestId, resumeKey: requestId, gateOrdinal: 0, action: common, evaluationTimeMs: now, dynamicFacts: {} })
        : adaptWorkflowAction({ schemaVersion: 1, organizationId: orgId, actor: { type: "user", id: userId }, owner: { type: "user", id: userId }, requestId, workflowDefinitionId: "override-bounds", workflowVersion: "1", workflowExecutionId: `override:${requestId}`, nodeId: "override-bounds", invocationId: requestId, action: common, evaluationTimeMs: now, dynamicFacts: {} });
      const envelope = assertEnvelope(adapted.request, await this.evaluator.evaluateAt(adapted.request, activeIdentity));
      buildActionObligationPlan(envelope.decision);
      const decision = envelope.decision;
      if (decision.reasonCode === "organization_policy" && decision.effect !== "allow") return { ok: false, error: `cannot set override mode "allow": org policy currently resolves "${decision.effect}" for ${action.actionId} (appliesIn: "${appliesIn}")` };
    }
    return { ok: true };
  }

  async authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> {
    const subjectDigest = requestSubjectDigest(request);
    const existing = await this.find(request.subject.orgId, request.idempotencyKey);
    if (existing) return this.replay(existing, subjectDigest);

    const envelope = await this.preview(request);
    const plan = buildDecisionAuditPlan({
      decisionId: canonicalDecisionId(request.subject.orgId, request.idempotencyKey),
      request, envelope, ...this.evidence,
      identityFactProvenance: [{ source: "host_asserted" }],
      policyFactProvenance: [{ source: "host_asserted" }],
      createdAtMs: this.now(),
    });
    await this.db.insert(authorizationDecisions).values(JSON.parse(canonicalAuthorizationJson(plan.row)) as AuthorizationDecisionRow).onConflictDoNothing();
    const stored = await this.find(request.subject.orgId, request.idempotencyKey);
    if (!stored) throw new Error("Canonical authorization decision reservation failed.");
    return this.replay(stored, subjectDigest);
  }

  private replay(row: AuthorizationDecisionRow, subjectDigest: string): PolicyDecisionEnvelope {
    if (row.requestSubjectDigest !== subjectDigest || !row.evidence) throw new Error("Canonical authorization idempotency conflict.");
    if (row.evaluatorKind !== this.evaluator.identity.kind || row.evaluatorEngineDigest !== this.evaluator.identity.engineDigest || row.evidence.schemaVersion !== 1 || row.evidence.profileDigest !== this.evidence.profileDigest || row.evidence.interpreterDigest !== this.evidence.interpreterDigest || row.evidence.contractDigest !== this.evidence.contractDigest) throw new Error("Canonical authorization replay evidence is invalid.");
    const decision = { effect: row.effect, reasonCode: row.reasonCode, matchedRuleIds: row.matchedRuleIds, obligations: row.obligations, redactions: row.redactions, ...(row.approvalRequirement ? { approvalRequirement: row.approvalRequirement } : {}) };
    if (decisionDigestOf(decision) !== row.evidence.decisionDigest || obligationDigestOf(decision) !== row.evidence.obligationDigest) throw new Error("Canonical authorization replay digest is invalid.");
    return { schemaVersion: 1, requestId: row.requestId, requestSubjectDigest: row.requestSubjectDigest, inputDigest: row.inputDigest, policyDigest: row.policyDigest, sourceBundleDigest: row.sourceBundleDigest, evaluator: { kind: row.evaluatorKind, engineDigest: row.evaluatorEngineDigest }, decision, decisionDigest: row.evidence.decisionDigest, obligationDigest: row.evidence.obligationDigest, evaluatedAtMs: row.evaluatedAt, ...(row.proof ? { proof: row.proof } : {}) };
  }

  private async find(orgId: string, idempotencyKey: string): Promise<AuthorizationDecisionRow | undefined> {
    return (await this.db.select().from(authorizationDecisions).where(and(eq(authorizationDecisions.orgId, orgId), eq(authorizationDecisions.idempotencyKey, idempotencyKey))).limit(1))[0];
  }
}
