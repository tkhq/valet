import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptCredentialDelegate, type AuthorizationRequest, type PolicyDecisionV1 } from "@valet/engine/authorization";
import { SourceBundleHost } from "./host.js";
import { InMemorySourceBundleStorage } from "./in-memory-storage.js";
import { LocalValetEvaluator } from "../evaluators/local-valet.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import {
  buildCurrentPolicyDynamicFacts,
  buildCurrentPolicySource,
  CurrentPolicySourceError,
  standardNewOrganizationPolicySnapshot,
} from "./current-policy-source.js";
import type { CurrentPolicySourceSnapshotV1 } from "./current-policy-types.js";

const ORG = "org-1";
const NOW = 1_000_000;
let runtime: WasmPolicyRuntime;

beforeAll(() => { runtime = new WasmPolicyRuntime(); });
afterAll(async () => { await runtime.close(); });

function snapshot(overrides: Partial<CurrentPolicySourceSnapshotV1> = {}): CurrentPolicySourceSnapshotV1 {
  return {
    ...standardNewOrganizationPolicySnapshot(ORG, "fixture-v1"),
    ...overrides,
  };
}

function orgRule(overrides: Partial<CurrentPolicySourceSnapshotV1["organizationPolicies"][number]> = {}): CurrentPolicySourceSnapshotV1["organizationPolicies"][number] {
  return {
    id: "org-rule",
    organizationId: ORG,
    authorizationKind: "tool.action",
    principalType: "org",
    principalId: ORG,
    actionId: "gmail.send_email",
    mode: "allow",
    paramMatchers: [],
    appliesIn: "any",
    expiresAtMs: null,
    revokedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    sourceTable: "action_policies",
    ...overrides,
  };
}

function teamRule(overrides: Partial<CurrentPolicySourceSnapshotV1["teamPolicies"][number]> = {}): CurrentPolicySourceSnapshotV1["teamPolicies"][number] {
  return {
    ...orgRule(),
    id: "team-rule",
    principalType: "team",
    principalId: "team-1",
    ...overrides,
  };
}

function personalRule(overrides: Partial<CurrentPolicySourceSnapshotV1["personalOverrides"][number]> = {}): CurrentPolicySourceSnapshotV1["personalOverrides"][number] {
  return {
    id: "personal-rule",
    organizationId: ORG,
    authorizationKind: "tool.action",
    userId: "user-1",
    actionId: "gmail.send_email",
    mode: "allow",
    paramMatchers: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    sourceTable: "action_policy_overrides",
    ...overrides,
  };
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-1",
    idempotencyKey: "interactive:1",
    kind: "tool.action",
    subject: {
      orgId: ORG,
      principal: { type: "user", id: "user-1" },
      invocation: { type: "interactive", id: "invocation-1" },
      sessionId: "session-1",
    },
    action: { service: "gmail", id: "gmail.send_email", riskLevel: "high", parameters: { to: "a@example.com", count: 5 } },
    context: { evaluationTimeMs: NOW },
    facts: {},
    ...overrides,
  };
}

async function evaluate(source: CurrentPolicySourceSnapshotV1, input = request()): Promise<{ decision: PolicyDecisionV1; policyDigest: string; sourceBundleDigest: string; inputDigest: string }> {
  const built = buildCurrentPolicySource(source);
  const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
  const identity = await host.publish(built.bundle);
  await host.activate(ORG, undefined, identity.sourceBundleDigest);
  const result = await runtime.run<{ decision: PolicyDecisionV1; policyDigest: string; sourceBundleDigest: string; inputDigest: string }>({
    operation: "evaluate",
    sourceBundleDigest: identity.sourceBundleDigest,
    input,
    explain: "off",
  });
  return result;
}

describe("current policy source builder", () => {
  it("builds and evaluates the standard new-organization bundle", async () => {
    const action = await evaluate(snapshot());
    expect(action.decision).toEqual({
      effect: "require_approval",
      reasonCode: "risk_default",
      matchedRuleIds: ["risk:high"],
      obligations: [],
      redactions: [],
      approvalRequirement: { tier: "human", approverType: "org", replay: "once" },
    });
    const unsupported = await evaluate(snapshot(), request({ kind: "api.route" }));
    expect(unsupported.decision).toMatchObject({ effect: "allow", reasonCode: "bundle_default", matchedRuleIds: ["standard.authenticated_access"] });
  });

  it("allows only one-level repository transport delegation by default", async () => {
    const delegated = adaptCredentialDelegate({
      schemaVersion: 1,
      organizationId: ORG,
      actorUserId: "user-1",
      principal: { type: "user", id: "user-1" },
      requestId: "credential-delegate-1",
      operationId: "credential-delegate-operation-1",
      evaluationTimeMs: NOW,
      parentSessionId: "parent-1",
      service: "github",
      credentialClass: "repository_transport",
      owner: { type: "user", id: "user-1" },
      delegatorSessionId: "parent-1",
      delegateeSessionId: "child-1",
      operations: ["repository.clone", "repository.fetch", "repository.push"],
      resource: { type: "repository", id: "github:acme/widgets" },
      expiresAtMs: NOW + 86_400_000,
      transitive: false,
    }).request;
    expect((await evaluate(snapshot(), delegated)).decision).toMatchObject({
      effect: "allow",
      matchedRuleIds: ["standard.credential.delegate.repository"],
    });

    for (const [name, parameters] of [
      ["service", { ...delegated.action.parameters, service: "onepassword" }],
      ["api", { ...delegated.action.parameters, credentialClass: "api_key" }],
      ["onepassword", { ...delegated.action.parameters, credentialClass: "onepassword_item" }],
      ["llm", { ...delegated.action.parameters, credentialClass: "llm_provider" }],
      ["owner", { ...delegated.action.parameters, owner: { type: "team", id: "team-1" } }],
      ["operation", { ...delegated.action.parameters, operations: ["repository.clone", "api.call"] }],
      ["resource", { ...delegated.action.parameters, resource: { type: "repository", id: "gitlab:acme/widgets" } }],
      ["transitive", { ...delegated.action.parameters, transitive: true }],
    ] as const) {
      const denied = await evaluate(snapshot(), { ...delegated, requestId: `denied-${name}`, action: { ...delegated.action, parameters } });
      expect(denied.decision.effect).toBe("deny");
    }
    const orgDenied = await evaluate(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "credential.delegate", actionId: "credential.delegate", mode: "deny" })] }), delegated);
    expect(orgDenied.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
  });

  it("keeps route and resource policy kinds independent", async () => {
    const source = snapshot({ organizationPolicies: [orgRule({ authorizationKind: "api.route", actionId: "api_sessions.post_sessions", mode: "deny" })] });
    const common = { schemaVersion: 1 as const, requestId: "request-route", context: { evaluationTimeMs: NOW }, facts: {}, subject: { orgId: ORG, principal: { type: "user" as const, id: "user-1" }, actorUserId: "user-1", invocation: { type: "route" as const, id: "delivery-route" } } };
    const route = await evaluate(source, { ...common, idempotencyKey: "route:delivery-route", kind: "api.route", action: { service: "api_sessions", id: "api_sessions.post_sessions", riskLevel: "medium", parameters: {} } });
    expect(route.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
    const resource = await evaluate(source, { ...common, requestId: "request-resource", idempotencyKey: "resource:delivery-resource", kind: "resource.access", subject: { ...common.subject, invocation: { type: "resource", id: "delivery-resource" } }, action: { service: "resource_session", id: "resource_session.create", riskLevel: "medium", parameters: {} }, resource: { type: "session" } });
    expect(resource.decision).toMatchObject({ effect: "allow", reasonCode: "bundle_default" });
  });

  it("rejects unknown route and resource source descriptors", () => {
    expect(() => buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "api.route", actionId: "api_sessions.unknown" })] }))).toThrow(expect.objectContaining({ code: "unknown_route_descriptor" }));
    expect(() => buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "resource.access", actionId: "resource_session.create" })] }))).toThrow(expect.objectContaining({ code: "unknown_resource_descriptor" }));
  });

  it("canonicalizes a PR 9 version 1 action-only snapshot", async () => {
    const legacy = { ...snapshot(), organizationPolicies: [orgRule({ authorizationKind: undefined })] };
    delete (legacy as { builtinDefaults?: unknown }).builtinDefaults;
    const built = buildCurrentPolicySource(legacy);
    const upgraded = buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule()] }));
    expect(built.bundle).toEqual(upgraded.bundle);
    expect(buildCurrentPolicySource(legacy).bundle).toEqual(built.bundle);
    expect(built.policySource).toContain('builtin_default["builtin.ask_approval"]');
    const action = await evaluate(legacy);
    expect(action.decision.reasonCode).toBe("organization_policy");
    const builtin = await evaluate(legacy, request({ kind: "tool.builtin", action: { service: "builtin", id: "builtin.read", riskLevel: "low", parameters: {} } }));
    expect(builtin.decision).toMatchObject({ effect: "allow", reasonCode: "builtin_default" });
  });

  it("publishes explicit built-in defaults in the same Rego bundle", async () => {
    const builtin = await evaluate(snapshot(), request({
      kind: "tool.builtin",
      action: { service: "builtin", id: "builtin.bash", riskLevel: "high", parameters: { timeout: 120 } },
      context: { evaluationTimeMs: NOW, capability: "process.execute", projectionVersion: 1 },
    }));
    expect(builtin.decision).toMatchObject({ effect: "require_approval", reasonCode: "builtin_default", matchedRuleIds: ["builtin-default:bash"] });
    const denied = await evaluate(snapshot({ organizationPolicies: [orgRule({ id: "deny-bash", authorizationKind: "tool.builtin", actionId: "builtin.bash", mode: "deny" })] }), request({ kind: "tool.builtin", action: { service: "builtin", id: "builtin.bash", riskLevel: "high", parameters: {} } }));
    expect(denied.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy", matchedRuleIds: ["deny-bash"] });
  });

  it("evaluates approval primitive allow, approval, and deny through Rego", async () => {
    const approvalRequest = request({ kind: "tool.builtin", action: { service: "builtin", id: "builtin.ask_approval", riskLevel: "low", parameters: {} } });
    const allowed = await evaluate(snapshot(), approvalRequest);
    expect(allowed.decision).toMatchObject({ effect: "allow", reasonCode: "builtin_default" });
    const gated = await evaluate(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "tool.builtin", service: "builtin", actionId: undefined, mode: "require_approval" })] }), approvalRequest);
    expect(gated.decision).toMatchObject({ effect: "require_approval", reasonCode: "organization_policy" });
    const denied = await evaluate(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "tool.builtin", actionId: "builtin.ask_approval", mode: "deny" })] }), approvalRequest);
    expect(denied.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
  });

  it("separates built-in policies from action policies at every target width", async () => {
    const builtinRequest = request({ kind: "tool.builtin", action: { service: "builtin", id: "builtin.bash", riskLevel: "high", parameters: {} } });
    for (const target of [{ actionId: "builtin.bash" }, { service: "builtin" }, { riskLevel: "high" as const }]) {
      const actionOnly = await evaluate(snapshot({ organizationPolicies: [orgRule({ ...target, actionId: target.actionId, service: target.service, riskLevel: target.riskLevel, authorizationKind: "tool.action", mode: "deny" })] }), builtinRequest);
      expect(actionOnly.decision.reasonCode).toBe("builtin_default");
      const builtinOnly = await evaluate(snapshot({ organizationPolicies: [orgRule({ ...target, actionId: target.actionId, service: target.service, riskLevel: target.riskLevel, authorizationKind: "tool.builtin", mode: "deny" })] }), builtinRequest);
      expect(builtinOnly.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
    }
    const action = await evaluate(snapshot({ organizationPolicies: [orgRule({ authorizationKind: "tool.builtin", actionId: "builtin.bash", mode: "deny" })] }));
    expect(action.decision.reasonCode).toBe("risk_default");
  });

  it("evaluates the generated bundle through LocalValetEvaluator", async () => {
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
    const identity = await host.publish(buildCurrentPolicySource(snapshot()).bundle);
    await host.activate(ORG, undefined, identity.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    const envelope = await evaluator.evaluate(request());
    expect(envelope.decision).toMatchObject({ effect: "require_approval", reasonCode: "risk_default" });
    expect(envelope).toMatchObject({ policyDigest: identity.policyDigest, sourceBundleDigest: identity.sourceBundleDigest });
    expect(envelope.inputDigest).toHaveLength(64);
  });

  it("produces byte-identical bundles and digests for permuted source rows", async () => {
    const rules = [
      orgRule({ id: "b", service: "gmail", actionId: undefined }),
      orgRule({ id: "a", mode: "require_approval", paramMatchers: [{ path: "to", op: "exists" }, { path: "count", op: "gte", value: 1 }] }),
    ];
    const first = buildCurrentPolicySource(snapshot({ organizationPolicies: rules }));
    const second = buildCurrentPolicySource(snapshot({
      organizationPolicies: [...rules].reverse().map((row) => ({ ...row, paramMatchers: [...row.paramMatchers].reverse() })),
      riskDefaults: [...snapshot().riskDefaults].reverse(),
    }));
    expect(second.bundle).toEqual(first.bundle);
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
    expect(await host.publish(second.bundle)).toEqual(await host.publish(first.bundle));
  });

  it.each([
    ["action allow beats service deny", [orgRule({ id: "service-deny", service: "gmail", actionId: undefined, mode: "deny" }), orgRule({ id: "action-allow" })], "allow", "action-allow"],
    ["same specificity deny wins", [orgRule({ id: "allow", updatedAtMs: 1 }), orgRule({ id: "deny", mode: "deny", updatedAtMs: 2 })], "deny", "deny"],
    ["service beats risk", [orgRule({ id: "risk", actionId: undefined, riskLevel: "high", mode: "deny" }), orgRule({ id: "service", actionId: undefined, service: "gmail", mode: "require_approval" })], "require_approval", "service"],
    ["expired row is excluded", [orgRule({ id: "expired", mode: "deny", expiresAtMs: NOW })], "require_approval", "risk:high"],
    ["revoked row is excluded", [orgRule({ id: "revoked", mode: "deny", revokedAtMs: 2 })], "require_approval", "risk:high"],
  ] as const)("preserves resolver specificity: %s", async (_name, policies, effect, winner) => {
    const result = await evaluate(snapshot({ organizationPolicies: policies }));
    expect(result.decision.effect).toBe(effect);
    expect(result.decision.matchedRuleIds).toContain(winner);

  });

  it("encodes all matcher operators with AND semantics", async () => {
    const paramMatchers = [
      { path: "to", op: "eq" as const, value: "a@example.com" },
      { path: "items[0].name", op: "eq" as const, value: "draft" },
      { path: "missing", op: "neq" as const, value: true },
      { path: "to", op: "regex" as const, value: "@example\\.com$" },
      { path: "count", op: "in" as const, value: [4, 5] },
      { path: "count", op: "not_in" as const, value: [6] },
      { path: "count", op: "gt" as const, value: 4 },
      { path: "count", op: "gte" as const, value: 5 },
      { path: "count", op: "lt" as const, value: 6 },
      { path: "count", op: "lte" as const, value: 5 },
      { path: "to", op: "exists" as const },
      { path: "absent", op: "not_exists" as const },
    ];
    const result = await evaluate(
      snapshot({ organizationPolicies: [orgRule({ id: "matched", mode: "deny", paramMatchers })] }),
      request({ action: { service: "gmail", id: "gmail.send_email", riskLevel: "high", parameters: { to: "a@example.com", count: 5, items: [{ name: "draft" }] } } }),
    );
    expect(result.decision).toMatchObject({ effect: "deny", matchedRuleIds: ["matched"] });
  });

  it("preserves plugin, risk, and bundle default authority", async () => {
    const plugin = await evaluate(snapshot({ pluginDefaults: [{ id: "plugin:gmail", service: "gmail", mode: "deny", sourcePath: "plugins/gmail" }] }));
    expect(plugin.decision).toMatchObject({ effect: "deny", reasonCode: "plugin_default", matchedRuleIds: ["plugin:gmail"] });


    const low = await evaluate(snapshot(), request({ action: { service: "gmail", id: "gmail.send_email", riskLevel: "low" } }));
    expect(low.decision).toMatchObject({ effect: "allow", reasonCode: "risk_default", matchedRuleIds: ["risk:low"] });

    // Expected difference: canonical bundles have an explicit safe fallback.
    // The legacy resolver hard-codes low risk to allow when no risk row exists.
    const fallback = await evaluate(snapshot({ riskDefaults: [] }), request({ action: { service: "gmail", id: "gmail.send_email", riskLevel: "low" } }));
    expect(fallback.decision).toMatchObject({ effect: "require_approval", reasonCode: "bundle_default" });

  });

  it("filters appliesIn and preserves personal workflow overrides", async () => {
    const source = snapshot({
      organizationPolicies: [orgRule({ mode: "deny", appliesIn: "session" })],
      personalOverrides: [personalRule({ mode: "allow" })],
    });
    const session = await evaluate(source);
    expect(session.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
    const workflow = await evaluate(source, request({
      kind: "workflow.action",
      subject: { ...request().subject, invocation: { type: "workflow", id: "node-1" }, sessionId: undefined, workflowExecutionId: "workflow-1" },
    }));
    expect(workflow.decision).toMatchObject({ effect: "allow", reasonCode: "personal_override" });
  });

  it("applies team policy only to its team and ignores personal overrides", async () => {
    const source = snapshot({ teamIds: ["team-1"], teamPolicies: [teamRule({ mode: "require_approval" })], personalOverrides: [personalRule({ mode: "allow" })] });
    const team = await evaluate(source, request({ subject: { ...request().subject, principal: { type: "team", id: "team-1" } } }));
    expect(team.decision).toMatchObject({ effect: "require_approval", reasonCode: "team_policy" });
    const personal = await evaluate(source);
    expect(personal.decision).toMatchObject({ effect: "allow", reasonCode: "personal_override" });
  });

  it("lets an organization or team winning deny beat grants and overrides", async () => {
    const facts = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [{
      schemaVersion: 1, id: "grant-1", organizationId: ORG, policyKey: "gmail.send_email", service: "gmail",
      actionId: "gmail.send_email", riskLevel: "high", appliesIn: "session", sessionId: "session-1",
      issuerId: "approver-1", sourceApprovalId: "approval-1", createdAtMs: 1, expiresAtMs: NOW + 1, revokedAtMs: null,
    }], approvals: [] });
    const denied = await evaluate(snapshot({ organizationPolicies: [orgRule({ mode: "deny" })], personalOverrides: [personalRule()] }), request({ facts: { currentPolicy: facts } }));
    expect(denied.decision).toMatchObject({ effect: "deny", reasonCode: "organization_policy" });
  });

  it("matches valid grants and excludes expired, revoked, and cross-scope facts", async () => {
    const baseGrant = {
      schemaVersion: 1 as const, id: "grant-1", organizationId: ORG, policyKey: "gmail.send_email", service: "gmail",
      actionId: "gmail.send_email", riskLevel: "high" as const, appliesIn: "session" as const, sessionId: "session-1",
      issuerId: "approver-1", sourceApprovalId: "approval-1", createdAtMs: 1, expiresAtMs: NOW + 1, revokedAtMs: null,
    };
    const valid = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [baseGrant], approvals: [] });
    const baseline = await evaluate(snapshot());
    const granted = await evaluate(snapshot(), request({ facts: { currentPolicy: valid } }));
    expect(granted.decision).toMatchObject({ effect: "allow", reasonCode: "dynamic_grant" });
    expect(granted.inputDigest).not.toBe(baseline.inputDigest);

    for (const grant of [
      { ...baseGrant, id: "expired", expiresAtMs: NOW },
      { ...baseGrant, id: "revoked", revokedAtMs: NOW - 1 },
      { ...baseGrant, id: "other", sessionId: "session-2" },
    ]) {
      const facts = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [grant], approvals: [] });
      expect((await evaluate(snapshot(), request({ facts: { currentPolicy: facts } }))).decision.effect).toBe("require_approval");
    }
  });

  it("binds approval facts to subject, decision, scope, and version", async () => {
    const approval = {
      schemaVersion: 1 as const, resolutionId: "resolution-1", approvalId: "approval-1", gateId: "gate-1",
      organizationId: ORG, requestSubjectDigest: "a".repeat(64), originalDecisionDigest: "b".repeat(64),
      approverId: "user-2", verdict: "approved" as const, appliesIn: "session" as const, sessionId: "session-1",
      resolvedAtMs: 1, expiresAtMs: NOW + 1, resolutionVersion: 1 as const,
    };
    const facts = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [], approvals: [approval] });
    const context = { evaluationTimeMs: NOW, requestSubjectDigest: "a".repeat(64), originalDecisionDigest: "b".repeat(64) };
    expect((await evaluate(snapshot(), request({ context, facts: { currentPolicy: facts } }))).decision.effect).toBe("allow");
    expect((await evaluate(snapshot(), request({ context: { ...context, requestSubjectDigest: "c".repeat(64) }, facts: { currentPolicy: facts } }))).decision.effect).toBe("require_approval");
  });

  it("fails malformed dynamic input closed and rejects malformed source", async () => {
    const malformed = await evaluate(snapshot(), request({ facts: { currentPolicy: { schemaVersion: 3, grants: [], approvals: [] } } }));
    expect(malformed.decision).toMatchObject({ effect: "deny", reasonCode: "malformed_dynamic_facts" });
    expect(() => buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule({ actionId: "send_email" })] }))).toThrow(CurrentPolicySourceError);
    expect(() => buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule({ id: "one" }), orgRule({ id: "two" })] }))).toThrow(/ambiguous/);
    expect(() => buildCurrentPolicySource(snapshot({ teamIds: [], teamPolicies: [teamRule()] }))).toThrow(/ownership/);
    expect(() => buildCurrentPolicySource(snapshot({ organizationPolicies: [orgRule({ paramMatchers: [{ path: "to", op: "regex", value: "(?=x)" }] })] }))).toThrow(/losslessly/);
    expect(() => buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [{
      schemaVersion: 1, id: "bad", organizationId: "other", policyKey: "gmail.send_email", service: "gmail",
      actionId: "gmail.send_email", riskLevel: "high", appliesIn: "session", sessionId: "session-1",
      issuerId: "x", sourceApprovalId: "a", createdAtMs: 1, expiresAtMs: 2, revokedAtMs: null,
    }], approvals: [] })).toThrow(/another organization/);
  });
});
