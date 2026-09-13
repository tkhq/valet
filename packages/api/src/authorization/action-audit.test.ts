import { describe, expect, it } from "vitest";
import { adaptInteractiveAction, canonicalAuthorizationJson, inputDigestOf, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { buildDecisionAuditPlan, buildExecutionAuditPlan } from "./action-audit.js";

const H = "a".repeat(64);
function uncheckedEnvelope(value: Omit<PolicyDecisionEnvelope, "evaluator"> & { evaluator: unknown }): PolicyDecisionEnvelope { return value as PolicyDecisionEnvelope; }
function fixture() {
  const adapted = adaptInteractiveAction({ schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" }, requestId: "request-1", sessionId: "session-1", threadId: "thread-1", queueItemId: "queue-1", resumeKey: "resume-1", gateOrdinal: 0, action: { service: "github", actionId: "github.create_issue", catalogActionId: "github.create_issue", sourcePluginService: "github", sourceActionId: "github.create_issue", sourceToolId: "call_tool", riskLevel: "high", parameters: { title: "safe", token: "SECRET-CANARY" }, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/title", required: true }] } }, evaluationTimeMs: 10, dynamicFacts: {} });
  const envelope: PolicyDecisionEnvelope = { schemaVersion: 1, requestId: adapted.request.requestId, requestSubjectDigest: adapted.requestSubjectDigest, inputDigest: inputDigestOf(adapted.request), policyDigest: H, sourceBundleDigest: H, evaluator: { kind: "local_valet", engineDigest: H }, decision: { effect: "allow", reasonCode: "rule", matchedRuleIds: ["z", "a"], obligations: [{ type: "target_idempotency", required: true }], redactions: [] }, evaluatedAtMs: 10 };
  return { ...adapted, envelope };
}
function decision() { const f = fixture(); return { f, plan: buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: f.envelope, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [{ source: "host_asserted" }], policyFactProvenance: [{ source: "host_asserted" }], createdAtMs: 11 }) }; }

describe("canonical authorization audit builders", () => {
  it("builds a separate strict decision row and digest evidence", () => {
    const { f, plan } = decision();
    expect(plan.row).toMatchObject({ decisionId: "decision-1", requestId: "request-1", effect: "allow", matchedRuleIds: ["a", "z"], inputDigest: f.envelope.inputDigest });
    expect(plan.evidence.decisionDigest).toHaveLength(64); expect(plan.evidence.obligationDigest).toHaveLength(64);
    expect(canonicalAuthorizationJson(plan)).not.toContain("SECRET-CANARY"); expect(Object.isFrozen(plan)).toBe(true);
  });

  it("rejects request identity and input digest mismatches", () => {
    const f = fixture();
    expect(() => buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: { ...f.envelope, inputDigest: "b".repeat(64) }, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [], policyFactProvenance: [], createdAtMs: 11 })).toThrowError(expect.objectContaining({ code: "digest_mismatch" }));
  });

  it("validates proof metadata and evaluator kind", () => {
    const f = fixture();
    expect(() => buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: { ...f.envelope, evaluator: { kind: "tvc_attested", engineDigest: H } }, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [], policyFactProvenance: [], createdAtMs: 11 })).toThrowError(expect.objectContaining({ code: "invalid_proof" }));
  });

  it("rejects malformed evaluation identity and time before row construction", () => {
    const f = fixture();
    const invalidKind = uncheckedEnvelope({ ...f.envelope, evaluator: { kind: "other", engineDigest: H } });
    expect(() => buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: invalidKind, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [], policyFactProvenance: [], createdAtMs: 11 })).toThrowError();
    expect(() => buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: { ...f.envelope, evaluatedAtMs: Number.NaN }, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [], policyFactProvenance: [], createdAtMs: 11 })).toThrowError();
  });

  it("snapshots audit inputs without invoking getters", () => {
    const f = fixture(); let reads = 0;
    const malicious = Object.defineProperty({}, "reasonCode", { enumerable: true, get: () => { reads++; return "rule"; } }) as PolicyDecisionEnvelope["decision"];
    expect(() => buildDecisionAuditPlan({ decisionId: "decision-1", request: f.request, envelope: { ...f.envelope, decision: malicious }, profileDigest: H, interpreterDigest: H, contractDigest: H, identityFactProvenance: [], policyFactProvenance: [], createdAtMs: 11 })).toThrowError();
    expect(reads).toBe(0);
    const { plan } = decision();
    expect(Object.isFrozen(plan.evidence)).toBe(true);
  });

  it("links retries to the stored decision without copying results or errors", () => {
    const { f, plan } = decision();
    const first = buildExecutionAuditPlan({ attemptId: "attempt-1", decision: plan, request: f.request, outcome: "failed", targetIdempotencyKey: "target-1", resultDigest: "b".repeat(64), externalOperationIds: ["external-2", "external-1", "external-1"], startedAtMs: 12, finishedAtMs: 13, error: new Error("SECRET-CANARY"), createdAtMs: 12 });
    const retry = buildExecutionAuditPlan({ attemptId: "attempt-2", decision: plan, request: f.request, outcome: "started", startedAtMs: 14, createdAtMs: 14 });
    expect(first.row).toMatchObject({ decisionId: "decision-1", redactedError: "Action execution failed.", redactedResult: { digest: "b".repeat(64) }, externalOperationIds: ["external-1", "external-2"] });
    expect(retry.row.decisionId).toBe(first.row.decisionId); expect(retry.row.attemptId).not.toBe(first.row.attemptId);
    expect(canonicalAuthorizationJson(first)).not.toContain("SECRET-CANARY");
  });

  it("rejects malformed attempt timing and cross-request linkage", () => {
    const { f, plan } = decision();
    expect(() => buildExecutionAuditPlan({ attemptId: "attempt-1", decision: plan, request: f.request, outcome: "started", startedAtMs: 12, finishedAtMs: 13, createdAtMs: 12 })).toThrowError(expect.objectContaining({ code: "invalid_attempt" }));
    expect(() => buildExecutionAuditPlan({ attemptId: "attempt-1", decision: plan, request: { ...f.request, requestId: "other" }, outcome: "started", startedAtMs: 12, createdAtMs: 12 })).toThrowError(expect.objectContaining({ code: "invalid_identity" }));
  });
});
