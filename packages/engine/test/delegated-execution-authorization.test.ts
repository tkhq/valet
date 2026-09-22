import { describe, expect, it } from "vitest";
import {
  adaptAgentSignal,
  adaptCredentialDelegate,
  adaptCredentialUse,
  adaptDelegationCreate,
  adaptEgressConnect,
  adaptSandboxCapability,
  assertNestedDelegationNarrower,
  assertOneLevelDelegationEnvelope,
  buildDelegatedExecutionObligationPlan,
  DELEGATED_EXECUTION_REGISTRY_V1,
  EgressBoundaryUnavailableError,
  normalizeEgressDestination,
  type DelegationEnvelopeV1,
} from "../src/authorization/index.js";

const common = {
  schemaVersion: 1 as const,
  organizationId: "org_1",
  actorUserId: "user_1",
  principal: { type: "user" as const, id: "user_1" },
  requestId: "request_1",
  operationId: "operation_1",
  evaluationTimeMs: 100,
};

function delegation() {
  return adaptDelegationCreate({
    ...common,
    parentSessionId: "parent_1",
    parentThreadId: "thread_1",
    childSessionId: "child_1",
    owner: common.principal,
    model: { kind: "tier", tier: "m" },
    profile: "headless",
    docker: false,
    limits: { durationMs: 60_000, turnLimit: 10, hopCount: 1 },
    taskClass: "code_review",
    capabilities: ["repository.read"],
    parentIsDelegatee: false,
  });
}

describe("delegated execution adapters", () => {
  it("registers every planned context without duplicates", () => {
    expect(new Set(DELEGATED_EXECUTION_REGISTRY_V1.map((entry) => `${entry.kind}:${entry.actionId}`)).size).toBe(DELEGATED_EXECUTION_REGISTRY_V1.length);
    expect(new Set(DELEGATED_EXECUTION_REGISTRY_V1.map((entry) => entry.kind))).toEqual(new Set(["delegation.create", "agent.signal", "sandbox.capability", "credential.use", "credential.delegate", "egress.connect"]));
    expect(DELEGATED_EXECUTION_REGISTRY_V1.every((entry) => !entry.approvalSupported)).toBe(true);
  });

  it("omits prompt, message, command, environment, and secret content", () => {
    const encoded = delegation().canonicalBytes;
    for (const forbidden of ["prompt", "message", "command", "environment", "secret", "requestBody"]) expect(encoded).not.toContain(forbidden);
  });

  it("changes identity when delegated intent changes", () => {
    const left = delegation();
    const changed = adaptDelegationCreate({
      ...common, parentSessionId: "parent_1", parentThreadId: "thread_1", childSessionId: "child_1", owner: common.principal,
      model: { kind: "tier", tier: "l" }, profile: "headless", docker: false, limits: { hopCount: 1 }, taskClass: "code_review", capabilities: ["repository.read"], parentIsDelegatee: false,
    });
    expect(changed.requestSubjectDigest).not.toBe(left.requestSubjectDigest);
  });

  it("rejects owner swaps and capability expansion", () => {
    expect(() => adaptDelegationCreate({
      ...common, parentSessionId: "parent_1", parentThreadId: "thread_1", childSessionId: "child_1",
      owner: { type: "user", id: "user_2" }, model: { kind: "tier", tier: "m" }, profile: "headless", docker: false,
      limits: { hopCount: 1 }, taskClass: "review", capabilities: [], parentIsDelegatee: false,
    })).toThrow(/owner_swap/);
    expect(() => adaptSandboxCapability({
      ...common, sessionId: "session_1", operation: "provision",
      requested: { profile: "headless", docker: false, browser: false, nestedKubernetes: false, tunnels: false, ports: [], capabilities: [] },
      effective: { profile: "full", docker: true, browser: false, nestedKubernetes: false, tunnels: false, ports: [], capabilities: [] },
    })).toThrow(/capability_expansion/);
  });

  it("binds signal type and target without a message body", () => {
    const read = adaptAgentSignal({ ...common, parentSessionId: "parent_1", parentThreadId: "thread_1", childSessionId: "child_1", operation: "read", relationship: "parent_child" });
    const cancel = adaptAgentSignal({ ...common, parentSessionId: "parent_1", parentThreadId: "thread_1", childSessionId: "child_1", operation: "cancel", relationship: "parent_child" });
    expect(read.requestSubjectDigest).not.toBe(cancel.requestSubjectDigest);
    expect(read.canonicalBytes).not.toContain("message");
  });

  it("keeps credential metadata separate from secret material", () => {
    const use = adaptCredentialUse({ ...common, sessionId: "session_1", service: "github", credentialClass: "installation", owner: common.principal, operation: "plugin", actionId: "github.list_repos", target: { sessionId: "session_1" }, resource: { type: "repository", id: "repo_1" } });
    const delegated = adaptCredentialDelegate({ ...common, sessionId: "session_1", service: "github", credentialClass: "installation", owner: common.principal, delegatorSessionId: "session_1", delegateeSessionId: "child_1", operations: ["github.list_repos"], resource: { type: "repository", id: "github:acme/widgets" }, expiresAtMs: 1_000, transitive: false });
    const prebuild = adaptCredentialUse({ ...common, service: "github", credentialClass: "installation", owner: { type: "org", id: common.organizationId }, operation: "repository", actionId: "prebuild.resolve_token", target: {}, resource: { type: "repository", id: "acme/widgets" } });
    expect(use.request.kind).toBe("credential.use");
    expect(prebuild.request.kind).toBe("credential.use");
    expect(delegated.request.kind).toBe("credential.delegate");
    expect(use.canonicalBytes).not.toMatch(/token|secret|apiKey/i);
  });

  it("normalizes safe DNS hosts and rejects ambiguous destinations", () => {
    expect(normalizeEgressDestination({ scheme: "https", protocol: "https", host: "API.Example.COM.", port: 443, destinationClass: "service" }).host).toBe("api.example.com");
    for (const host of ["127.0.0.1", "localhost", "xn--e1afmkfd.xn--p1ai", "a..example.com", "[::1]"]) {
      expect(() => adaptEgressConnect({ ...common, sessionId: "session_1", operation: "connect", destination: { scheme: "https", protocol: "https", host, port: 443, destinationClass: "external" } })).toThrow(/invalid_destination/);
    }
    expect(() => adaptEgressConnect({ ...common, sessionId: "session_1", operation: "connect", destination: { scheme: "https", protocol: "https", host: "api.example.com", port: 443, destinationClass: "external" } })).toThrow(EgressBoundaryUnavailableError);
  });

  it("fails closed on nested or malformed delegation", () => {
    const base: DelegationEnvelopeV1 = { schemaVersion: 1, organizationId: "org_1", parentSessionId: "root_1", parentThreadId: "thread_1", childSessionId: "child_1", actorUserId: "user_1", owner: common.principal, depth: 1, parentRootCapable: true, constraints: {}, capabilities: ["repository.read"], expiresAtMs: 1_000, policyDigest: "a".repeat(64), sourceBundleDigest: "b".repeat(64), evaluatorKind: "local_valet", engineDigest: "c".repeat(64) };
    expect(() => assertOneLevelDelegationEnvelope(base)).not.toThrow();
    expect(() => assertOneLevelDelegationEnvelope(base, base)).toThrow(/nested_delegation_unsupported/);
    expect(() => adaptDelegationCreate({ ...common, parentSessionId: "child_1", parentThreadId: "thread_1", childSessionId: "grandchild_1", owner: common.principal, model: { kind: "tier", tier: "s" }, profile: "headless", docker: false, limits: { hopCount: 1 }, taskClass: "task", capabilities: [], parentIsDelegatee: true })).toThrow(/nested_delegation_unsupported/);
    expect(() => assertNestedDelegationNarrower(base, { ...base, parentSessionId: "child_1", childSessionId: "grandchild_1", capabilities: ["repository.write"] })).toThrow(/delegation_widening/);
  });

  it("fails closed on unknown obligations", () => {
    expect(() => buildDelegatedExecutionObligationPlan({ effect: "allow", reasonCode: "test", matchedRuleIds: [], obligations: [{ type: "read_only", required: true }], redactions: [] })).toThrow(/unsupported_obligation/);
  });
});
