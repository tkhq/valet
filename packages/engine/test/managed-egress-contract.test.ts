import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, SandboxAttachment, validateManagedEgressRequest, type SandboxProvider } from "../src/index.js";

const request = { requested: true as const, proxyToken: "t".repeat(48), identity: { orgId: "o", sessionId: "s", workloadId: "w", proxyId: "p", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } };
function provider(ready: boolean): SandboxProvider {
  return {
    backend: "test",
    capabilities: () => ({ snapshot: "none", persistentWorkspace: false, tunnels: false, warmPool: false, hibernation: false, customImage: false, managedEgress: { supported: ready, configured: ready, ready } }),
    create: async () => { throw new Error("not called"); }, restore: async () => { throw new Error("not called"); }, destroy: async () => {}, status: async (id) => ({ id, state: "released" }),
  };
}
describe("managed egress provider contract", () => {
  it("rejects malformed runtime requests", () => {
    expect(() => validateManagedEgressRequest({ ...request, requested: false } as unknown as typeof request)).toThrow(ManagedEgressPrerequisiteError);
    expect(() => validateManagedEgressRequest({ ...request, proxyToken: undefined } as unknown as typeof request)).toThrow(ManagedEgressPrerequisiteError);
  });

  it("rejects before attachment side effects unless capability is fully ready", () => {
    expect(() => new SandboxAttachment(provider(false), { managedEgress: request })).toThrow(ManagedEgressPrerequisiteError);
    const attachment = new SandboxAttachment(provider(true), { managedEgress: request });
    expect(attachment.state).toBe("detached"); expect(attachment.currentEpoch()).toBe(0);
  });
});
