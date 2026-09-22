import { describe, expect, it } from "vitest";
import { HEMATITE_COMPATIBLE_SOURCE_COMMIT, HEMATITE_REQUEST_ID_PATTERN, MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, SandboxAttachment, VirtualSandbox, isHematiteRequestId, parseManagedEgressPersistedState, validateManagedEgressRequest, type ManagedEgressEffectiveState, type SandboxProvider } from "../src/index.js";

const request = { requested: true as const, proxyToken: "t".repeat(48), identity: { orgId: "o", sessionId: "s", workloadId: "w", proxyId: "p", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } };
function provider(ready: boolean): SandboxProvider {
  return {
    backend: "test",
    capabilities: () => ({ snapshot: "none", persistentWorkspace: false, tunnels: false, warmPool: false, hibernation: false, customImage: false, managedEgress: { supported: ready, configured: ready, ready } }),
    create: async () => { throw new Error("not called"); }, restore: async () => { throw new Error("not called"); }, destroy: async () => {}, status: async (id) => ({ id, state: "released" }),
  };
}
describe("managed egress provider contract", () => {
  it("pins the Hematite request ID contract to its compatible source", () => {
    expect(HEMATITE_COMPATIBLE_SOURCE_COMMIT).toBe("35cdd0bc8816afefb4012ba2f9ca66b927c1aa00");
    expect(HEMATITE_REQUEST_ID_PATTERN.source).toBe("^[0-9a-f]{32}-[0-9a-f]{16}$");
    expect(isHematiteRequestId("000000000000000018db1a2b3c4d5e6f-0000000000000001")).toBe(true);
    for (const value of ["request.id", "-request", "request!", "123-1"]) expect(isHematiteRequestId(value), value).toBe(false);
  });

  it("rejects malformed and open runtime request shapes", () => {
    const malformed: unknown[] = [
      null,
      { ...request, requested: false },
      { ...request, proxyToken: undefined },
      { ...request, extra: true },
      { ...request, identity: { ...request.identity, extra: true } },
      { ...request, identity: { orgId: "o", sessionId: "s", workloadId: "w", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } },
    ];
    for (const value of malformed) expect(() => validateManagedEgressRequest(value)).toThrow(ManagedEgressPrerequisiteError);
    const valid: unknown = request;
    validateManagedEgressRequest(valid);
    expect(valid.identity.proxyId).toBe("p");
    expect(() => validateManagedEgressRequest({ ...request, proxyToken: "🔐".repeat(8) })).not.toThrow();
    expect(() => validateManagedEgressRequest({ ...request, proxyToken: "🔐".repeat(1025) })).toThrow(ManagedEgressPrerequisiteError);
  });

  it("rejects credentials and unknown fields in persisted metadata", () => {
    const persisted = { requested: { identity: request.identity } };
    expect(parseManagedEgressPersistedState(persisted)).toEqual(persisted);
    expect(() => parseManagedEgressPersistedState({ ...persisted, proxyToken: request.proxyToken })).toThrow(ManagedEgressPrerequisiteError);
    expect(() => parseManagedEgressPersistedState({ requested: { ...persisted.requested, privateKey: "secret" } })).toThrow(ManagedEgressPrerequisiteError);
  });

  it("becomes ready only after the provider registers and re-observes the boundary", async () => {
    let registered = false;
    const effective: ManagedEgressEffectiveState = {
      requested: true, configured: true, ready: true, effective: true,
      identity: request.identity,
      proxyArtifact: `registry.example/hematite@sha256:${"a".repeat(64)}`,
      topology: {
        proxyResources: ["proxy-1"], policyResources: ["policy-1"],
        workloadSelector: { "valet.dev/session": "s" }, callbackBindingId: "binding-1",
      },
    };
    const managedProvider: SandboxProvider = {
      ...provider(true),
      create: async (opts) => {
        expect(registered).toBe(false);
        opts.managedEgressLifecycle?.registerCallbackBinding();
        return new VirtualSandbox("managed-sandbox");
      },
      status: async (id) => ({ id, state: "ready", ...(registered ? { managedEgress: effective } : {}) }),
    };
    const attachment = new SandboxAttachment(managedProvider, {
      managedEgress: request,
      managedEgressLifecycle: {
        registerCallbackBinding: () => { registered = true; },
        revokeCallbackBinding: () => { registered = false; },
      },
    });
    await attachment.ensureReady({ timeoutMs: 1_000 });
    expect(attachment.managedEgressEffectiveState()).toEqual(effective);
    await attachment.destroy();
    expect(registered).toBe(false);
  });

  it("fails typed-unavailable and revokes when the provider cannot observe the boundary", async () => {
    let registered = false;
    const missingProvider: SandboxProvider = {
      ...provider(true),
      create: async (opts) => {
        opts.managedEgressLifecycle?.registerCallbackBinding();
        return new VirtualSandbox("missing-boundary");
      },
      status: async (id) => ({ id, state: "ready" }),
    };
    const attachment = new SandboxAttachment(missingProvider, {
      managedEgress: request,
      managedEgressLifecycle: {
        registerCallbackBinding: () => { registered = true; },
        revokeCallbackBinding: () => { registered = false; },
      },
    });
    await expect(attachment.ensureReady({ timeoutMs: 1_000 })).rejects.toBeInstanceOf(ManagedEgressPrerequisiteError);
    expect(registered).toBe(false);
    expect(attachment.state).toBe("error");
  });

  it("rejects before attachment side effects unless capability is fully ready", () => {
    expect(() => new SandboxAttachment(provider(false), { managedEgress: request })).toThrow(ManagedEgressPrerequisiteError);
    const attachment = new SandboxAttachment(provider(true), { managedEgress: request });
    expect(attachment.state).toBe("detached"); expect(attachment.currentEpoch()).toBe(0);
  });
});
