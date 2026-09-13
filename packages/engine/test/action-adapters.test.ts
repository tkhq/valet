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
  type AuthorizationRequest,
  type InteractiveActionAdapterInputV1,
  type PolicyDecisionEnvelope,
} from "../src/authorization/index.js";

const H = "a".repeat(64);
const base: InteractiveActionAdapterInputV1 = {
  schemaVersion: 1, organizationId: "org-1", actor: { type: "user", id: "user-1" }, owner: { type: "user", id: "user-1" },
  requestId: "request-1", sessionId: "session-1", threadId: "thread-1", queueItemId: "queue-1", resumeKey: "github.create_issue:{\"title\":\"x\"}", gateOrdinal: 0,
  action: { service: "github", actionId: "github.create_issue", catalogActionId: "github.create_issue", sourcePluginService: "github", sourceActionId: "github.create_issue", sourceToolId: "call_tool", riskLevel: "high", parameters: { title: "x", nested: { visible: 1, token: "SECRET-CANARY" }, rows: [{ visible: 2, password: "SECRET-CANARY" }] }, parameterProjection: { schemaVersion: 1, safePaths: ["/title", "/nested/visible", "/rows/*/visible"] } },
  evaluationTimeMs: 1000, dynamicFacts: { currentPolicy: { schemaVersion: 2, grants: [], approvals: [], approvalBinding: null, organizationId: "org-1" } },
};

function interactive(over: Partial<InteractiveActionAdapterInputV1> = {}) { return adaptInteractiveAction({ ...base, ...over }); }
function envelope(request: AuthorizationRequest, effect: "allow" | "deny" | "require_approval" = "allow"): PolicyDecisionEnvelope {
  return { schemaVersion: 1, requestId: request.requestId, requestSubjectDigest: interactive().requestSubjectDigest, inputDigest: inputDigestOf(request), policyDigest: H, sourceBundleDigest: H, evaluator: { kind: "local_valet", engineDigest: H }, decision: { effect, reasonCode: "rule", matchedRuleIds: ["r"], obligations: [], redactions: [], ...(effect === "require_approval" ? { approvalRequirement: { tier: "human", approverType: "org" as const, replay: "once" as const, expiresAtMs: 2000 } } : {}) }, evaluatedAtMs: 1000 };
}

describe("canonical action request adapters", () => {
  it("keeps equivalent interactive and workflow action data and facts equal", () => {
    const left = interactive().request;
    const right = adaptWorkflowAction({ schemaVersion: 1, organizationId: base.organizationId, actor: base.actor, owner: base.owner, requestId: "request-2", action: base.action, evaluationTimeMs: base.evaluationTimeMs, dynamicFacts: base.dynamicFacts, workflowDefinitionId: "workflow-1", workflowVersion: "version-1", workflowExecutionId: "execution-1", nodeId: "node-1", invocationId: "invocation-1" }).request;
    expect(canonicalAuthorizationJson(left.action)).toBe(canonicalAuthorizationJson(right.action));
    expect(canonicalAuthorizationJson(left.facts)).toBe(canonicalAuthorizationJson(right.facts));
    expect(left.subject.invocation.type).toBe("interactive"); expect(right.subject.invocation.type).toBe("workflow");
  });

  it("is deterministic under object permutations and changes semantic digests", () => {
    const a = interactive(), b = interactive({ action: { ...base.action, parameters: { rows: [{ password: "SECRET-CANARY", visible: 2 }], nested: { token: "SECRET-CANARY", visible: 1 }, title: "x" } } });
    expect(a.canonicalBytes).toBe(b.canonicalBytes); expect(a.requestSubjectDigest).toBe(b.requestSubjectDigest);
    expect(interactive({ action: { ...base.action, parameters: { title: "y", nested: { visible: 1 }, rows: [{ visible: 2 }] } } }).requestSubjectDigest).not.toBe(a.requestSubjectDigest);
  });

  it.each([
    [{ organizationId: "bad org" }, "invalid_identity"],
    [{ owner: { type: "user", id: "other" } }, "identity_conflict"],
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
    expect(() => interactive({ action: { ...base.action, parameterProjection: undefined } as never })).toThrowError(expect.objectContaining({ code: "invalid_shape" }));
  });

  it("bounds cyclic, deep, oversized, accessor, and proxy values without exposing secrets", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const deep: Record<string, unknown> = {}; let at = deep; for (let i = 0; i < 40; i++) { at.next = {}; at = at.next as Record<string, unknown>; }
    const getter = Object.defineProperty({}, "safe", { enumerable: true, get: () => { throw new Error("SECRET-CANARY"); } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SECRET-CANARY"); } });
    for (const parameters of [cycle, deep, { safe: "x".repeat(70_000) }, getter, proxy]) {
      let error = ""; try { interactive({ action: { ...base.action, parameters, parameterProjection: { schemaVersion: 1, safePaths: [""] } } }); } catch (caught) { error = String(caught); }
      expect(error).toContain("unsafe_parameters"); expect(error).not.toContain("SECRET-CANARY");
    }
  });

  it("adapts current plugin catalog definitions without executing them", () => {
    const execute = vi.fn(async () => ({ success: true }));
    const action = { id: "create_issue", name: "Create", description: "Create", riskLevel: "high" as const, parameters: Type.Object({ title: Type.String() }), execute };
    const out = adaptPluginCatalogAction({ plugin: { service: "github", actions: [action] }, action, params: { title: "safe" }, projection: { schemaVersion: 1, safePaths: [""] }, context: { userId: "user-1", orgId: "org-1", sessionId: "session-1", threadId: "thread-1", owner: { type: "user", id: "user-1" }, queueItemId: "queue-1" }, requestId: "request-1", resumeKey: "github.create_issue:{\"title\":\"x\"}", gateOrdinal: 0, evaluationTimeMs: 1000, dynamicFacts: {} });
    expect(out.request.action.id).toBe("github.create_issue"); expect(execute).not.toHaveBeenCalled();
  });

  it("never includes unprojected nested secret bytes", () => {
    const out = interactive();
    expect(out.canonicalBytes).not.toContain("SECRET-CANARY");
    expect(canonicalAuthorizationJson(out.request)).not.toContain("SECRET-CANARY");
    expect(out.request.action.parameters).toEqual({ nested: { visible: 1 }, rows: [{ visible: 2 }], title: "x" });
  });
});

describe("obligation, approval, and compatibility helpers", () => {
  it("builds immutable pre and post plans and rejects unknown obligations", () => {
    const plan = buildActionObligationPlan({ effect: "allow", reasonCode: "x", matchedRuleIds: [], obligations: [{ type: "credential_owner", ownerType: "user", ownerId: "user-1" }, { type: "target_idempotency", required: true }], redactions: [{ target: "audit", jsonPaths: ["$.z", "$.z"] }] });
    expect(plan.preExecution).toHaveLength(2); expect(plan.postExecution[0]?.jsonPaths).toEqual(["$.z"]); expect(Object.isFrozen(plan)).toBe(true);
    expect(() => buildActionObligationPlan({ effect: "allow", reasonCode: "x", matchedRuleIds: [], obligations: [{ type: "egress_hosts", hosts: ["x"] }], redactions: [] })).toThrowError(expect.objectContaining({ code: "unsupported_obligation" }));
  });

  it("binds approvals to request, input, policy, decision, scope, replay, and expiry", () => {
    const request = interactive().request, approval = buildCanonicalApprovalPlan(request, envelope(request, "require_approval"));
    expect(approval.binding).toMatchObject({ actionId: "github.create_issue", sessionId: "session-1", replay: "once", expiresAtMs: 2000 });
    expect(() => assertApprovalBinding(approval.binding, { ...approval.binding, inputDigest: "b".repeat(64) }, 1500)).toThrowError(expect.objectContaining({ code: "invalid_binding" }));
    expect(() => assertApprovalBinding(approval.binding, approval.binding, 2000)).toThrowError(expect.objectContaining({ code: "expired_approval" }));
  });

  it.each(["allow", "deny", "require_approval"] as const)("maps canonical %s without a legacy evaluator", async (effect) => {
    const request = interactive().request, authorize = vi.fn(async () => envelope(request, effect));
    const resolver = authorizationServicePolicyResolver({ authorize }, () => request);
    const result = await resolver.resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
    expect(result.mode).toBe(effect); expect(result.canonical?.decisionDigest).toBe(decisionDigestOf(envelope(request, effect).decision)); expect(authorize).toHaveBeenCalledOnce();
  });

  it("maps service errors, malformed decisions, and unsupported obligations to deny", async () => {
    const request = interactive().request;
    for (const authorize of [vi.fn(async () => { throw new Error("SECRET-CANARY"); }), vi.fn(async () => ({ ...envelope(request), requestId: "wrong" })), vi.fn(async () => ({ ...envelope(request), decision: { ...envelope(request).decision, obligations: [{ type: "sandbox_capabilities", capabilities: ["x"] }] } }))]) {
      const result = await authorizationServicePolicyResolver({ authorize }, () => request).resolve({ service: "github", actionId: "github.create_issue", riskLevel: "high", params: {}, sessionId: "session-1", threadId: "thread-1", appliesIn: "session" });
      expect(result.mode).toBe("deny"); expect(canonicalAuthorizationJson(result)).not.toContain("SECRET-CANARY");
    }
  });
});
