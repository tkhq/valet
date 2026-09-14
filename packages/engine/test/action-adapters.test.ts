import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { adaptPluginCatalogAction } from "../src/plugin-catalog-authorization.js";
import {
  ActionAdapterError,
  adaptInteractiveAction,
  adaptWorkflowAction,
  assertApprovalBinding,
  authorizationServicePolicyResolver,
  buildActionObligationPlan,
  buildCanonicalApprovalPlan,
  canonicalAuthorizationJson,
  decisionDigestOf,
  inputDigestOf,
  obligationDigestOf,
  requestSubjectDigest,
  validateCurrentPolicyDynamicFactsV2,
  type AuthorizationRequest,
  type PolicyDecisionV1,
  type CurrentPolicyDynamicFactsV2,
  type InteractiveActionAdapterInputV1,
  type PolicyDecisionEnvelope,
} from "../src/authorization/index.js";

const H = "a".repeat(64);
const B = "b".repeat(64);
const EVIDENCE = { profileDigest: H, interpreterDigest: H, contractDigest: H };
const base: InteractiveActionAdapterInputV1 = {
  schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" },
  requestId: "request-1", sessionId: "session-1", threadId: "thread-1", queueItemId: "queue-1", resumeKey: "github.create_issue:{\"title\":\"x\"}", gateOrdinal: 0,
  action: { service: "github", actionId: "github.create_issue", catalogActionId: "github.create_issue", sourcePluginService: "github", sourceActionId: "github.create_issue", sourceToolId: "call_tool", riskLevel: "high", parameters: { title: "x", nested: { visible: 1, token: "SECRET-CANARY" }, rows: [{ visible: 2, password: "SECRET-CANARY" }] }, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/title", required: true }, { pointer: "/nested/visible", required: true }, { pointer: "/rows/*/visible", required: true }] } },
  evaluationTimeMs: 1000, dynamicFacts: { currentPolicy: { schemaVersion: 2, grants: [], approvals: [], approvalBinding: null, organizationId: "org-1" } },
};

function interactive(over: Partial<InteractiveActionAdapterInputV1> = {}) { return adaptInteractiveAction({ ...base, ...over }); }
function envelope(request: AuthorizationRequest, effect: "allow" | "deny" | "require_approval" = "allow"): PolicyDecisionEnvelope {
  const decision: PolicyDecisionV1 = { effect, reasonCode: "rule", matchedRuleIds: ["r"], obligations: [], redactions: [], ...(effect === "require_approval" ? { approvalRequirement: { tier: "human", approverType: "org" as const, replay: "once" as const, expiresAtMs: 2000 } } : {}) };
  return { schemaVersion: 1, requestId: request.requestId, requestSubjectDigest: requestSubjectDigest(request), inputDigest: inputDigestOf(request), policyDigest: H, sourceBundleDigest: H, evaluator: { kind: "local_valet", engineDigest: H }, decision, decisionDigest: decisionDigestOf(decision), obligationDigest: obligationDigestOf(decision), evaluatedAtMs: 1000 };
}

describe("canonical action request adapters", () => {
  it("keeps equivalent interactive and workflow action data and facts equal", () => {
    const left = interactive().request;
    const right = adaptWorkflowAction({ schemaVersion: 1, organizationId: base.organizationId, actor: base.actor, owner: base.owner, requestId: "request-2", action: base.action, evaluationTimeMs: base.evaluationTimeMs, dynamicFacts: base.dynamicFacts, workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowExecutionId: "execution-1", nodeId: "node-1", invocationId: "invocation-1" }).request;
    expect(canonicalAuthorizationJson(left.action)).toBe(canonicalAuthorizationJson(right.action));
    expect(canonicalAuthorizationJson(left.facts)).toBe(canonicalAuthorizationJson(right.facts));
    expect(left.subject.invocation.type).toBe("interactive"); expect(right.subject.invocation.type).toBe("workflow");
  });

  it("accepts queued actors and the engine's pretty-printed resume keys", () => {
    expect(interactive({ owner: { type: "user", id: "credential-owner" } }).request.subject.principal.id).toBe("credential-owner");
    expect(interactive({ resumeKey: "github.create_issue:{\n  \"title\": \"x\"\n}" }).request.subject.invocation.type).toBe("interactive");
    expect(() => interactive({ resumeKey: "github.create_issue:\u0000" })).toThrowError(expect.objectContaining({ code: "invalid_identity" }));
  });

  it("is deterministic under object permutations and changes semantic digests", () => {
    const a = interactive(), b = interactive({ action: { ...base.action, parameters: { rows: [{ password: "SECRET-CANARY", visible: 2 }], nested: { token: "SECRET-CANARY", visible: 1 }, title: "x" } } });
    expect(a.canonicalBytes).toBe(b.canonicalBytes); expect(a.requestSubjectDigest).toBe(b.requestSubjectDigest);
    expect(interactive({ action: { ...base.action, parameters: { title: "y", nested: { visible: 1 }, rows: [{ visible: 2 }] } } }).requestSubjectDigest).not.toBe(a.requestSubjectDigest);
  });

  it.each([
    [{ organizationId: "bad org" }, "invalid_identity"],
    [{ owner: { type: "team", id: "team-1" } }, "cross_scope"],
    [{ owner: { type: "team", id: "team-1" }, teamId: "team-2" }, "cross_scope"],
    [{ action: { ...base.action, actionId: "slack.create_issue" } }, "invalid_action"],
    [{ action: { ...base.action, riskLevel: "unknown" } }, "unknown_risk"],
    [{ evaluationTimeMs: -1 }, "invalid_facts"],
  ] as const)("rejects invalid identity, scope, action, risk, or facts", (patch, code) => {
    expect(() => interactive(patch as Partial<InteractiveActionAdapterInputV1>)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects unknown fields and missing safe projection", () => {
    expect(() => adaptInteractiveAction({ ...base, extra: true } as InteractiveActionAdapterInputV1)).toThrowError(ActionAdapterError);
    expect(() => interactive({ action: { ...base.action, parameterProjection: undefined } as never })).toThrowError(expect.objectContaining({ code: "unsafe_parameters" }));
  });

  it("bounds cyclic, deep, oversized, accessor, and proxy values without exposing secrets", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const deep: Record<string, unknown> = {}; let at = deep; for (let i = 0; i < 40; i++) { at.next = {}; at = at.next as Record<string, unknown>; }
    const getter = Object.defineProperty({}, "safe", { enumerable: true, get: () => { throw new Error("SECRET-CANARY"); } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SECRET-CANARY"); } });
    for (const parameters of [cycle, deep, { safe: "x".repeat(70_000) }, getter, proxy]) {
      let error = ""; try { interactive({ action: { ...base.action, parameters, parameterProjection: { schemaVersion: 1, mode: "all_safe" } } }); } catch (caught) { error = String(caught); }
      expect(error).toContain("unsafe_parameters"); expect(error).not.toContain("SECRET-CANARY");
    }
  });

  it("adapts current plugin catalog definitions without executing them", () => {
    const execute = vi.fn(async () => ({ success: true }));
    const action = { id: "create_issue", name: "Create", description: "Create", riskLevel: "high" as const, parameters: Type.Object({ title: Type.String() }), execute };
    const out = adaptPluginCatalogAction({ plugin: { service: "github", actions: [action] }, action, params: { title: "safe" }, projection: { schemaVersion: 1, mode: "all_safe" }, context: { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1" }, requestId: "request-1", resumeKey: "github.create_issue:{\"title\":\"x\"}", gateOrdinal: 0, evaluationTimeMs: 1000, dynamicFacts: {} });
    expect(out.request.action.id).toBe("github.create_issue"); expect(execute).not.toHaveBeenCalled();
    const replay = adaptPluginCatalogAction({ plugin: { service: "github", actions: [action] }, action, params: { title: "safe" }, projection: { schemaVersion: 1, mode: "all_safe" }, context: { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1" }, requestId: "request-after-restart", resumeKey: "github.create_issue:{\"title\":\"x\"}", gateOrdinal: 0, evaluationTimeMs: 1000, dynamicFacts: {} });
    expect(replay.requestSubjectDigest).toBe(out.requestSubjectDigest);
    expect(() => adaptPluginCatalogAction({ plugin: { service: "github", actions: [action] }, action, params: {}, projection: { schemaVersion: 1, mode: "none" }, context: { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" } }, requestId: "request-1", resumeKey: "stable", gateOrdinal: 0, evaluationTimeMs: 1000, dynamicFacts: {} })).toThrowError(/queueItemId/);
  });

  it("never includes unprojected nested secret bytes", () => {
    const out = interactive();
    expect(out.canonicalBytes).not.toContain("SECRET-CANARY");
    expect(canonicalAuthorizationJson(out.request)).not.toContain("SECRET-CANARY");
    expect(out.request.action.parameters).toEqual({ nested: { visible: 1 }, rows: [{ visible: 2 }], title: "x" });
  });

  it("makes none and optional projection semantics explicit", () => {
    const none = interactive({ action: { ...base.action, parameterProjection: { schemaVersion: 1, mode: "none" } } });
    expect(none.request.action.parameters).toEqual({});
    expect(none.request.context.parameterProjection).toEqual({ schemaVersion: 1, mode: "none" });
    const optional = interactive({ action: { ...base.action, parameters: { title: "x", rows: [{ visible: 1 }, {}] }, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/title", required: true }, { pointer: "/missing", required: false }, { pointer: "/rows/*/visible", required: false }] } } });
    expect(optional.request.action.parameters).toEqual({ rows: [{ visible: 1 }, {}], title: "x" });
  });

  it("rejects empty selected paths, missing required paths, and array indices", () => {
    expect(() => interactive({ action: { ...base.action, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [] } } })).toThrowError(ActionAdapterError);
    expect(() => interactive({ action: { ...base.action, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/missing", required: true }] } } })).toThrowError(ActionAdapterError);
    expect(() => interactive({ action: { ...base.action, parameterProjection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/rows/0/visible", required: true }] } } })).toThrowError(ActionAdapterError);
  });

  it("handles a real optional TypeBox catalog shape without denying", () => {
    const execute = vi.fn(async () => ({ success: true }));
    const action = { id: "create_issue", name: "Create", description: "Create", riskLevel: "high" as const, parameters: Type.Object({ title: Type.String(), body: Type.Optional(Type.String()) }), execute };
    const out = adaptPluginCatalogAction({ plugin: { service: "github", actions: [action] }, action, params: { title: "safe" }, projection: { schemaVersion: 1, mode: "selected", paths: [{ pointer: "/title", required: true }, { pointer: "/body", required: false }] }, context: { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1" }, requestId: "request-1", resumeKey: "stable", gateOrdinal: 0, evaluationTimeMs: 1000, dynamicFacts: {} });
    expect(out.request.action.parameters).toEqual({ title: "safe" }); expect(execute).not.toHaveBeenCalled();
  });

  it("rejects malformed #679 tuple supply", () => {
    const context = { organizationId: "org-1", service: "github", actionId: "github.create_issue", riskLevel: "high" as const, appliesIn: "session" as const, scopeId: "session-1", evaluationTimeMs: 1000 };
    const grant = ["grant-1", "github.create_issue", "github", "github.create_issue", "high", "session", "session-1", 1, 2000, null];
    const valid = { schemaVersion: 2, organizationId: "org-1", grants: [grant], approvalBinding: null, approvals: [] };
    for (const malformed of [
      { ...valid, schemaVersion: "2" }, { ...valid, organizationId: "org-2" }, { ...valid, grants: [[...grant].slice(0, 9)] },
      { ...valid, grants: [[...grant.slice(0, 4), "unknown", ...grant.slice(5)]] }, { ...valid, grants: [[...grant.slice(0, 7), 1001, 2000, null]] },
      { ...valid, grants: [[...grant.slice(0, 9), 10]] }, { ...valid, grants: Array.from({ length: 9 }, (_, index) => [`grant-${index}`, ...grant.slice(1)]) },
    ]) expect(() => validateCurrentPolicyDynamicFactsV2(malformed, context)).toThrow();
  });

  it("validates #679 facts against action, scope, time, and binding context", () => {
    const currentPolicy: CurrentPolicyDynamicFactsV2 = { schemaVersion: 2, organizationId: "org-1", grants: [["grant-1", "github.create_issue", "github", "github.create_issue", "high", "session", "session-1", 1, 2000, null]], approvalBinding: null, approvals: [] };
    expect(interactive({ dynamicFacts: { currentPolicy } }).request.facts.currentPolicy).toEqual(currentPolicy);
    const wrongAction = { ...currentPolicy, grants: [["grant-1", "github.delete_issue", "github", "github.delete_issue", "high", "session", "session-1", 1, 2000, null]] } as CurrentPolicyDynamicFactsV2;
    expect(() => interactive({ dynamicFacts: { currentPolicy: wrongAction } })).toThrowError(expect.objectContaining({ code: "invalid_facts" }));
    const approved: CurrentPolicyDynamicFactsV2 = { schemaVersion: 2, organizationId: "org-1", grants: [], approvalBinding: [H, B, "session", "session-1"], approvals: [["resolution-1", "approved", 10, 2000, 1]] };
    expect(interactive({ dynamicFacts: { currentPolicy: approved }, approvalBindingContext: { requestSubjectDigest: H, originalDecisionDigest: B } }).request.facts.currentPolicy).toEqual(approved);
    expect(() => interactive({ dynamicFacts: { currentPolicy: approved }, approvalBindingContext: { requestSubjectDigest: B, originalDecisionDigest: B } })).toThrowError(expect.objectContaining({ code: "invalid_facts" }));
  });
});

describe("obligation, approval, and compatibility helpers", () => {
  it("builds immutable pre and post plans and rejects unknown obligations", () => {
    const plan = buildActionObligationPlan({ effect: "allow", reasonCode: "x", matchedRuleIds: [], obligations: [{ type: "credential_owner", ownerType: "user", ownerId: "user-1" }, { type: "target_idempotency", required: true }], redactions: [{ target: "audit", jsonPaths: ["$.z", "$.z"] }] });
    expect(plan.preExecution).toHaveLength(2); expect(plan.postExecution[0]?.jsonPaths).toEqual(["$.z"]); expect(Object.isFrozen(plan)).toBe(true);
    expect(() => buildActionObligationPlan({ effect: "allow", reasonCode: "x", matchedRuleIds: [], obligations: [{ type: "egress_hosts", hosts: ["x"] }], redactions: [] })).toThrowError(expect.objectContaining({ code: "unsupported_obligation" }));
  });

  it.each([
    { reasonCode: 7 }, { reasonCode: null }, { matchedRuleIds: [7] }, { matchedRuleIds: [false] },
    { approvalRequirement: { tier: 7, approverType: "org", replay: "once" }, effect: "require_approval" },
    { approvalRequirement: { tier: "human", approverType: 7, replay: "once" }, effect: "require_approval" },
    { approvalRequirement: { tier: "human", approverType: "org", approverId: false, replay: "once" }, effect: "require_approval" },
    { approvalRequirement: { tier: "human", approverType: "org", replay: 7 }, effect: "require_approval" },
  ])("rejects non-string decision primitives %#", (patch) => {
    const malformed = { effect: "allow", reasonCode: "rule", matchedRuleIds: [], obligations: [], redactions: [], ...patch } as PolicyDecisionV1;
    expect(() => buildActionObligationPlan(malformed)).toThrowError(expect.objectContaining({ code: "invalid_decision" }));
  });

  it("binds approvals to request, input, policy, decision, scope, replay, and expiry", () => {
    const request = interactive().request, approval = buildCanonicalApprovalPlan(request, envelope(request, "require_approval"), EVIDENCE);
    expect(approval.binding).toMatchObject({ actionId: "github.create_issue", sessionId: "session-1", replay: "once", expiresAtMs: 2000 });
    expect(canonicalAuthorizationJson(approval)).not.toContain("SECRET-CANARY");
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, inputDigest: "b".repeat(64) }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, engineDigest: B }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, profileDigest: B }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, contractDigest: B }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, sourceBundleDigest: B }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, approval.binding, 2000)).toThrowError(expect.objectContaining({ code: "expired_approval" }));
  });

  it.each([
    { tier: "Human", approverType: "org", replay: "once" },
    { tier: "human", approverType: "anyone", replay: "once" },
    { tier: "human", approverType: "org", replay: "forever" },
    { tier: "human", approverType: "org", replay: "once", expiresAtMs: -1 },
    { tier: "human", approverType: "org", replay: "once", unknown: true },
  ])("rejects malformed approval requirement %#", (approvalRequirement) => {
    const request = interactive().request;
    const decision = { ...envelope(request, "require_approval").decision, approvalRequirement } as PolicyDecisionV1;
    const malformed: PolicyDecisionEnvelope = { ...envelope(request, "require_approval"), decision };
    expect(() => buildCanonicalApprovalPlan(request, malformed, EVIDENCE)).toThrowError(expect.objectContaining({ code: "invalid_decision" }));
  });

  it.each(["allow", "deny", "require_approval"] as const)("maps canonical %s without a legacy evaluator", async (effect) => {
    const request = interactive().request, authorize = vi.fn(async () => envelope(request, effect));
    const resolver = authorizationServicePolicyResolver({ authorize }, () => request);
    const result = await resolver.resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(result.mode).toBe(effect); expect(result.provenance.source).toBe("canonical_service"); expect(result.canonical?.decisionDigest).toBe(decisionDigestOf(envelope(request, effect).decision)); expect(authorize).toHaveBeenCalledOnce();
  });

  it("snapshots service results and rejects getter-backed requests", async () => {
    const request = interactive().request;
    const supplied = envelope(request);
    const resolver = authorizationServicePolicyResolver({ authorize: async () => supplied }, () => request);
    const result = await resolver.resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    supplied.decision.reasonCode = "mutated"; supplied.decision.obligations.push({ type: "target_idempotency", required: true });
    expect(result.canonical?.reasonCode).toBe("rule"); expect(result.canonical?.obligations).toEqual([]); expect(Object.isFrozen(result.canonical)).toBe(true);
    let reads = 0;
    const action = Object.defineProperty({}, "id", { enumerable: true, get: () => { reads++; return "github.create_issue"; } }) as AuthorizationRequest["action"];
    const badRequest = { ...request, action };
    const authorize = vi.fn(async () => supplied);
    const denied = await authorizationServicePolicyResolver({ authorize }, () => badRequest).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(denied.mode).toBe("deny"); expect(reads).toBe(0); expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects getter and post-validation mutation in service decisions", async () => {
    const request = interactive().request;
    let reads = 0;
    const decision = Object.defineProperty({}, "reasonCode", { enumerable: true, get: () => { reads++; return "rule"; } }) as PolicyDecisionV1;
    const result = await authorizationServicePolicyResolver({ authorize: async () => ({ ...envelope(request), decision }) }, () => request).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(result.mode).toBe("deny"); expect(reads).toBe(0);
  });

  it.each([
    { inputDigest: B }, { requestSubjectDigest: B }, { evaluator: { kind: "other", engineDigest: H } },
    { decisionDigest: B }, { obligationDigest: B }, { evaluatedAtMs: 1.5 },
  ])("rejects forged envelope binding %#", async (patch) => {
    const request = interactive().request;
    const forged = { ...envelope(request), ...patch } as PolicyDecisionEnvelope;
    const result = await authorizationServicePolicyResolver({ authorize: async () => forged }, () => request).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(result).toMatchObject({ mode: "deny", provenance: { source: "resolver_error" } });
  });

  it.each(["bundle_not_found", "unsupported_context"])("maps %s service failures to typed deny", async (code) => {
    const request = interactive().request;
    const result = await authorizationServicePolicyResolver({ authorize: async () => { throw Object.assign(new Error("SECRET-CANARY"), { code }); } }, () => request).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(result).toMatchObject({ mode: "deny", canonical: { reasonCode: `fail_closed.${code}` } });
    expect(canonicalAuthorizationJson(result)).not.toContain("SECRET-CANARY");
  });

  it("maps service errors, malformed decisions, and unsupported obligations to deny", async () => {
    const request = interactive().request;
    for (const authorize of [vi.fn(async () => { throw new Error("SECRET-CANARY"); }), vi.fn(async () => ({ ...envelope(request), requestId: "wrong" })), vi.fn(async () => ({ ...envelope(request), decision: { ...envelope(request).decision, obligations: [{ type: "sandbox_capabilities", capabilities: ["x"] }] } }))]) {
      const result = await authorizationServicePolicyResolver({ authorize }, () => request).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
      expect(result.mode).toBe("deny"); expect(canonicalAuthorizationJson(result)).not.toContain("SECRET-CANARY");
    }
  });
});
