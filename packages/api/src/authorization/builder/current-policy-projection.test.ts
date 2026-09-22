import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptEgressConnect, type AuthorizationRequest } from "@valet/engine/authorization";
import { buildCurrentPolicySource } from "../bundles/current-policy-source.js";
import { SourceBundleHost } from "../bundles/host.js";
import { InMemorySourceBundleStorage } from "../bundles/in-memory-storage.js";
import { LocalValetEvaluator } from "../evaluators/local-valet.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import { normalizePolicyDraft } from "./model.js";
import { projectDraftToCurrentSnapshot } from "./current-policy-projection.js";
import type { CurrentOrganizationPolicyV1 } from "../bundles/current-policy-types.js";
import type { JsonValue, PolicyDraftV1, PolicyRuleDraftV1 } from "./types.js";

let runtime: WasmPolicyRuntime;
beforeAll(() => {
  runtime = new WasmPolicyRuntime();
});
afterAll(async () => runtime.close());
const draft: PolicyDraftV1 = {
  schemaVersion: 1,
  draftId: "draft-1",
  rules: [
    {
      ruleId: "rule-1",
      context: "tool.action",
      authority: "organization",
      owner: { kind: "org", id: "org-1" },
      subjects: ["org"],
      target: { "action.id": "gmail.send_email" },
      matcherGroups: [
        {
          id: "group-1",
          mode: "all",
          matchers: [
            {
              id: "matcher-1",
              field: "parameters.to",
              operator: "eq",
              value: "a@example.com",
            },
          ],
        },
      ],
      effect: "deny",
      appliesIn: "any",
      obligations: [],
      description: "",
      metadata: {},
    },
  ],
};
const request: AuthorizationRequest = {
  schemaVersion: 1,
  requestId: "request-1",
  idempotencyKey: "invocation-1",
  kind: "tool.action",
  subject: {
    orgId: "org-1",
    principal: { type: "user", id: "user-1" },
    invocation: { type: "interactive", id: "invocation-1" },
    sessionId: "session-1",
  },
  action: {
    service: "gmail",
    id: "gmail.send_email",
    riskLevel: "high",
    parameters: { to: "a@example.com" },
  },
  context: { evaluationTimeMs: 100 },
  facts: {},
};

describe("browser draft to current source contract", () => {
  it("maps losslessly, validates the bundle, and evaluates through LocalValetEvaluator", async () => {
    const normalized = normalizePolicyDraft(draft);
    const snapshot = projectDraftToCurrentSnapshot(normalized, "org-1");
    expect(snapshot.organizationPolicies[0]).toEqual({ id: "rule-1", organizationId: "org-1", authorizationKind: "tool.action", actionId: "gmail.send_email", mode: "deny", paramMatchers: [{ path: "to", op: "eq", value: "a@example.com" }], createdAtMs: 1, updatedAtMs: 1, principalType: "org", principalId: "org-1", appliesIn: "any", expiresAtMs: null, revokedAtMs: null, sourceTable: "action_policies", sourcePath: "builder/draft-1/rule-1" });
    const built = buildCurrentPolicySource(snapshot);
    const provenance = JSON.parse(Buffer.from(built.bundle.files.find((file) => file.path.startsWith("provenance/"))!.contentBase64, "base64").toString("utf8"));
    expect(provenance.entries.find((entry: { rule_id: string }) => entry.rule_id === "rule-1")).toMatchObject({
      rule_id: "rule-1",
      start_line: expect.any(Number),
      end_line: expect.any(Number),
    });
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime),
      identity = await host.publish(built.bundle);
    await host.activate("org-1", undefined, identity.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime),
      result = await evaluator.evaluate(request);
    expect(result.decision).toMatchObject({
      effect: "deny",
      matchedRuleIds: ["rule-1"],
    });
    expect(result.policyDigest).toBe(identity.policyDigest);
  });
  it.each(["workflow.action", "approval", "description", "obligations", "subjects"] as const)("rejects lossy %s projection", field => {
    const patch: Partial<PolicyRuleDraftV1> = field === "workflow.action" ? { context: field } : field === "approval" ? { approval: { tier: "human", replay: "once" } } : field === "description" ? { description: "lost" } : field === "obligations" ? { obligations: [{ type: "redact" }] } : { subjects: ["user"] };
    const changed: PolicyDraftV1 = { ...draft, rules: [{ ...draft.rules[0], ...patch }] };
    expect(() => projectDraftToCurrentSnapshot(normalizePolicyDraft(changed), "org-1")).toThrow(/preserve|approval|reject|tool.action|does not support/i);
  });

  it.each(PROJECTABLE_TARGETS)("projects every browser-valid target %j", target => {
    const changed: PolicyDraftV1 = { ...draft, rules: [{ ...draft.rules[0], target }] }, snapshot = projectDraftToCurrentSnapshot(normalizePolicyDraft(changed), "org-1");
    expect(() => buildCurrentPolicySource(snapshot)).not.toThrow(); expect(snapshot.organizationPolicies).toHaveLength(1);
  });

  it.each<Readonly<Record<string, JsonValue>>>([{ "action.id": "builtin.bash" }, { "action.service": "builtin" }, { "action.riskLevel": "high" }] as const)("round-trips built-in kind and target %j", (target) => {
    const rule = { ...draft.rules[0], context: "tool.builtin" as const, target, matcherGroups: [] };
    const snapshot = projectDraftToCurrentSnapshot(normalizePolicyDraft({ ...draft, rules: [rule] }), "org-1");
    expect(snapshot.organizationPolicies[0]).toMatchObject({ authorizationKind: "tool.builtin" });
    expect(() => buildCurrentPolicySource(snapshot)).not.toThrow();
  });

  it.each([
    ["delegation.create", "delegation.create"],
    ["agent.signal", "agent.cancel"],
    ["sandbox.capability", "sandbox.provision"],
    ["credential.use", "credential.repository"],
    ["credential.delegate", "credential.delegate"],
  ] as const)("projects non-egress %s policies", (context, actionId) => {
    const rule = { ...draft.rules[0], context, target: { "action.id": actionId }, matcherGroups: [], appliesIn: undefined };
    const snapshot = projectDraftToCurrentSnapshot(normalizePolicyDraft({ ...draft, rules: [rule] }), "org-1");
    expect(snapshot.organizationPolicies[0]).toMatchObject({ authorizationKind: context, actionId });
    expect(() => buildCurrentPolicySource(snapshot)).not.toThrow();
  });

  it("publishes and evaluates canonical exact and suffix egress targets", async () => {
    const rule = {
      ...draft.rules[0], context: "egress.connect" as const, target: { "action.id": "egress.connect" }, appliesIn: undefined,
      effect: "allow" as const,
      matcherGroups: [{ id: "egress-targets", mode: "all" as const, matchers: [
        { id: "scheme", field: "parameters.destination.scheme", operator: "eq" as const, value: "https" },
        { id: "host", field: "parameters.destination.host", operator: "suffix" as const, value: "example.com" },
        { id: "port", field: "parameters.destination.port", operator: "eq" as const, value: 443 },
        { id: "class", field: "parameters.destination.destinationClass", operator: "eq" as const, value: "external" },
      ] }],
    };
    const normalized = normalizePolicyDraft({ ...draft, rules: [rule] });
    const snapshot = projectDraftToCurrentSnapshot(normalized, "org-1");
    expect(snapshot.organizationPolicies[0]).toMatchObject({ authorizationKind: "egress.connect", actionId: "egress.connect", paramMatchers: expect.arrayContaining([{ path: "destination.host", op: "suffix", value: "example.com" }]) });
    const built = buildCurrentPolicySource(snapshot);
    const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
    const identity = await host.publish(built.bundle);
    await host.activate("org-1", undefined, identity.sourceBundleDigest);
    const evaluator = await LocalValetEvaluator.create(host, runtime);
    const egress = (hostName: string) => adaptEgressConnect({ schemaVersion: 1, organizationId: "org-1", actorUserId: "user-1", principal: { type: "user", id: "user-1" }, requestId: `egress-${hostName.replaceAll(".", "-")}`, operationId: `op-${hostName.replaceAll(".", "-")}`, evaluationTimeMs: 100, sessionId: "session-1", operation: "connect", destination: { scheme: "https", protocol: "tcp", host: hostName, port: 443, destinationClass: "external" } }).request;
    expect((await evaluator.evaluate(egress("api.example.com"))).decision.effect).toBe("allow");
    expect((await evaluator.evaluate(egress("example.com"))).decision.effect).toBe("allow");
    expect((await evaluator.evaluate(egress("evil-example.com"))).decision.effect).toBe("deny");
  });

  it("projects a bare approval mode without custom approval fields", () => {
    const changed: PolicyDraftV1 = { ...draft, rules: [{ ...draft.rules[0], effect: "require_approval", approval: undefined }] }, snapshot = projectDraftToCurrentSnapshot(normalizePolicyDraft(changed), "org-1");
    expect(snapshot.organizationPolicies[0].mode).toBe("require_approval"); expect(() => buildCurrentPolicySource(snapshot)).not.toThrow();
  });

  it.each(INVALID_SOURCE_TARGETS)("source rejects target grammar %j", (patch, code) => {
    const current = projectDraftToCurrentSnapshot(normalizePolicyDraft(draft), "org-1"), row = { ...current.organizationPolicies[0], actionId: undefined, ...patch };
    expect(() => buildCurrentPolicySource({ ...current, organizationPolicies: [row] })).toThrow(expect.objectContaining({ code }));
  });

});

const PROJECTABLE_TARGETS: readonly Readonly<Record<string, JsonValue>>[] = [{ "action.service": "gmail" }, { "action.id": "gmail.send_email" }, { "action.riskLevel": "high" }];

const INVALID_SOURCE_TARGETS: readonly (readonly [Partial<CurrentOrganizationPolicyV1>, string])[] = [[{ service: "Gmail" }, "invalid_service"], [{ actionId: "gmail" }, "invalid_action"], [{ actionId: "gmail.Send" }, "invalid_action"], [{ service: "gmail", actionId: "gmail.send" }, "invalid_target"]];
