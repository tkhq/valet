import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { assertEnvelope, buildActionObligationPlan, canonicalAuthorizationJson, decisionDigestOf, obligationDigestOf, requestSubjectDigest, type AuthorizationRequest, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { AppDb } from "../lib/drizzle.js";
import { authorizationDecisions, type AuthorizationDecisionRow } from "../schema/index.js";
import { buildDecisionAuditPlan } from "./action-audit.js";
import type { AuthorizationService } from "./contracts.js";
import { LocalValetEvaluator } from "./evaluators/local-valet.js";
import type { CanonicalPolicyBundleManager } from "./canonical-policy-manager.js";

export function canonicalDecisionId(orgId: string, idempotencyKey: string): string {
  return `decision:${createHash("sha256").update(`${orgId}\0${idempotencyKey}`).digest("hex")}`;
}

export class CanonicalAuthorizationService implements AuthorizationService {
  private constructor(
    private readonly db: AppDb,
    private readonly evaluator: LocalValetEvaluator,
    private readonly evidence: { profileDigest: string; interpreterDigest: string; contractDigest: string },
    private readonly now: () => number,
  ) {}

  static async create(manager: CanonicalPolicyBundleManager, now: () => number = Date.now): Promise<CanonicalAuthorizationService> {
    const identity = await manager.runtime.identity();
    const digest = (value: unknown) => createHash("sha256").update(canonicalAuthorizationJson(value)).digest("hex");
    return new CanonicalAuthorizationService(manager.db, await LocalValetEvaluator.create(manager.host, manager.runtime), {
      profileDigest: digest({ capabilityProfileVersion: identity.capabilityProfileVersion, maxWallTimeMs: identity.maxWallTimeMs, maxEngineMemoryBytes: identity.maxEngineMemoryBytes }),
      interpreterDigest: digest({ name: identity.interpreterName, version: identity.interpreterVersion, revision: identity.interpreterRevision, regoVersion: identity.regoVersion }),
      contractDigest: digest({ contractVersion: identity.contractVersion }),
    }, now);
  }

  async authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> {
    const subjectDigest = requestSubjectDigest(request);
    const existing = await this.find(request.subject.orgId, request.idempotencyKey);
    if (existing) return this.replay(existing, subjectDigest);

    const envelope = assertEnvelope(request, await this.evaluator.evaluate(request));
    buildActionObligationPlan(envelope.decision);
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
