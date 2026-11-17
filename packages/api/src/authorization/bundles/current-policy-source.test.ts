import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorizationRequest, PolicyDecisionV1 } from "@valet/engine/authorization";
import { resolvePolicyDecision, type ActionPolicyOverrideRow, type ActionPolicyRow } from "../../policies/resolution.js";
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
    const unsupported = await evaluate(snapshot(), request({ kind: "route.access" }));
    expect(unsupported.decision).toMatchObject({ effect: "deny", reasonCode: "unsupported_authorization_context" });
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

    const legacy: ActionPolicyRow[] = policies.map((row) => ({
      id: row.id, principalType: "org", service: row.service ?? null, actionId: row.actionId ?? null,
      riskLevel: row.riskLevel ?? null, mode: row.mode, paramMatchers: [...row.paramMatchers], appliesIn: row.appliesIn,
      expiresAt: row.expiresAtMs, revokedAt: row.revokedAtMs, updatedAt: row.updatedAtMs,
    }));
    expect(resolvePolicyDecision({ policies: legacy, grants: [], overrides: [] }, {
      service: "gmail", actionId: "gmail.send_email", riskLevel: "high", params: { to: "a@example.com", count: 5 },
      appliesIn: "session", sessionId: "session-1", now: NOW,
    }, undefined).mode).toBe(effect);
  });

  describe("partial parameters", () => {
    const params = { to: "a@example.com", nested: { label: "x" }, list: ["a"] };
    type Matcher = CurrentPolicySourceSnapshotV1["organizationPolicies"][number]["paramMatchers"][number];
    const cases: ReadonlyArray<readonly [string, "allow" | "require_approval" | "deny", Matcher]> = [
      ["deny on an absent path", "deny", { path: "prompt", op: "eq", value: "secret" }],
      ["approval on an absent path", "require_approval", { path: "prompt", op: "regex", value: "secret" }],
      ["deny on an object path", "deny", { path: "nested", op: "eq", value: { label: "y" } }],
      ["deny on an array path", "deny", { path: "list", op: "in", value: [["b"]] }],
      ["deny on a present scalar that does not match", "deny", { path: "to", op: "eq", value: "b@example.com" }],
      ["allow on an absent path", "allow", { path: "prompt", op: "not_exists" }],
      ["allow on an object path", "allow", { path: "nested", op: "eq", value: { label: "x" } }],
      ["allow on a present scalar that matches", "allow", { path: "to", op: "eq", value: "a@example.com" }],
    ];

    it.each(cases.flatMap(([name, mode, matcher]) => [true, false].map((partial) => [`${name}${partial ? " with partial parameters" : ""}`, mode, matcher, partial] as const)))(
      "matches the resolver for %s",
      async (_name, mode, matcher, partial) => {
        const rule = orgRule({ id: "partial-rule", mode, paramMatchers: [matcher] });
        // A broader rule with a different mode, so a skipped rule changes the result.
        const fallback = orgRule({ id: "service-fallback", actionId: undefined, service: "gmail", mode: mode === "allow" ? "require_approval" : "allow" });
        const result = await evaluate(snapshot({ organizationPolicies: [rule, fallback] }), request({
          action: { ...request().action, parameters: params },
          context: { evaluationTimeMs: NOW, ...(partial ? { partialParams: true } : {}) },
        }));
        const legacy = resolvePolicyDecision({ policies: [rule, fallback].map((row) => ({
          id: row.id, principalType: "org", service: row.service ?? null, actionId: row.actionId ?? null, riskLevel: null,
          mode: row.mode, paramMatchers: [...row.paramMatchers], appliesIn: row.appliesIn, expiresAt: null, revokedAt: null,
          updatedAt: 1,
        })), grants: [], overrides: [] }, {
          service: "gmail", actionId: "gmail.send_email", riskLevel: "high", params, appliesIn: "session",
          sessionId: "session-1", now: NOW, ...(partial ? { partialParams: true } : {}),
        }, undefined);
        expect(result.decision.effect).toBe(legacy.mode);
      },
    );
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
    expect(resolvePolicyDecision({ policies: [], grants: [], overrides: [] }, {
      service: "gmail", actionId: "gmail.send_email", riskLevel: "high", params: {}, appliesIn: "session", sessionId: "session-1", now: NOW,
    }, "deny")).toMatchObject({ mode: "deny", provenance: { source: "plugin_default" } });

    const low = await evaluate(snapshot(), request({ action: { service: "gmail", id: "gmail.send_email", riskLevel: "low" } }));
    expect(low.decision).toMatchObject({ effect: "allow", reasonCode: "risk_default", matchedRuleIds: ["risk:low"] });

    // Expected difference: canonical bundles have an explicit safe fallback.
    // The legacy resolver hard-codes low risk to allow when no risk row exists.
    const fallback = await evaluate(snapshot({ riskDefaults: [] }), request({ action: { service: "gmail", id: "gmail.send_email", riskLevel: "low" } }));
    expect(fallback.decision).toMatchObject({ effect: "require_approval", reasonCode: "bundle_default" });
    expect(resolvePolicyDecision({ policies: [], grants: [], overrides: [] }, {
      service: "gmail", actionId: "gmail.send_email", riskLevel: "low", params: {}, appliesIn: "session", sessionId: "session-1", now: NOW,
    }, undefined).mode).toBe("allow");
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

  it("matches a thread-scoped grant only in its own thread", async () => {
    const grant = {
      schemaVersion: 1 as const, id: "thread-grant", organizationId: ORG, policyKey: "gmail.send_email", service: "gmail",
      actionId: "gmail.send_email", riskLevel: "high" as const, appliesIn: "session" as const, sessionId: "session-1",
      threadId: "thread-1", issuerId: "approver-1", sourceApprovalId: "approval-1", createdAtMs: 1, expiresAtMs: NOW + 1,
      revokedAtMs: null,
    };
    const facts = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [grant], approvals: [] });
    const inThread = (threadId: string | undefined) => request({
      subject: { ...request().subject, ...(threadId === undefined ? {} : { threadId }) },
      facts: { currentPolicy: facts },
    });
    expect((await evaluate(snapshot(), inThread("thread-1"))).decision.effect).toBe("allow");
    expect((await evaluate(snapshot(), inThread("thread-2"))).decision.effect).toBe("require_approval");
    expect((await evaluate(snapshot(), inThread(undefined))).decision.effect).toBe("require_approval");

    const unscoped = buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [{ ...grant, id: "session-grant", threadId: undefined }], approvals: [] });
    expect((await evaluate(snapshot(), request({
      subject: { ...request().subject, threadId: "thread-2" },
      facts: { currentPolicy: unscoped },
    }))).decision.effect).toBe("allow");

    expect(() => buildCurrentPolicyDynamicFacts({ organizationId: ORG, grants: [{
      ...grant, id: "workflow-thread", appliesIn: "workflow", sessionId: undefined, workflowExecutionId: "workflow-1",
    }], approvals: [] })).toThrow(expect.objectContaining({ code: "invalid_scope" }));
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
