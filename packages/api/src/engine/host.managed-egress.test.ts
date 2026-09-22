import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, type SessionData } from "@valet/engine";
import { managedEgressRestoreOptions } from "./host.js";
import { ManagedEgressBindingRegistry, type AuthorizationRequestV1 } from "../routes/managed-egress-authorization.js";

const identity = {
  orgId: "org-1",
  sessionId: "session-1",
  workloadId: "workload-1",
  proxyId: "proxy-1",
  contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
};
const effective = {
  requested: true as const, configured: true as const, ready: true as const, effective: true as const,
  identity,
  proxyArtifact: "hematite@sha256:test",
  topology: {
    proxyResources: ["proxy-1"], policyResources: ["policy-1"],
    workloadSelector: { session: identity.sessionId }, callbackBindingId: "proxy-1",
  },
};
const expected = {
  sessionId: identity.sessionId,
  orgId: identity.orgId,
  policyIdentity: { actorUserId: "user-1", principal: { type: "user" as const, id: "user-1" } },
};
const persisted: NonNullable<SessionData["managedEgress"]> = { requested: { identity } };
const authorizationRequest: AuthorizationRequestV1 = {
  version: "1", request_id: "000000000000000018db1a2b3c4d5e6f-0000000000000001", service: "egress", action: "connect",
  subject: { session_id: identity.sessionId, workload_id: identity.workloadId },
  destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443 },
};

describe("managed egress restart options", () => {
  it("registers only after effective topology observation and revokes on loss", async () => {
    const registry = new ManagedEgressBindingRegistry();
    const restored = managedEgressRestoreOptions(persisted, expected, registry);
    if (!restored?.managedEgress || !restored.managedEgressLifecycle) throw new Error("expected managed restore options");

    expect(await registry.authorize(restored.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    restored.managedEgressLifecycle.registerCallbackBinding(effective);
    expect((await registry.authorize(restored.managedEgress.proxyToken, authorizationRequest))?.decision).toBe("deny");
    restored.managedEgressLifecycle.revokeCallbackBinding();
    expect(await registry.authorize(restored.managedEgress.proxyToken, authorizationRequest)).toBeNull();
  });

  it("mints a fresh process-epoch token and leaves the old registry unauthorized", async () => {
    const oldRegistry = new ManagedEgressBindingRegistry();
    const oldRestore = managedEgressRestoreOptions(persisted, expected, oldRegistry);
    if (!oldRestore?.managedEgress || !oldRestore.managedEgressLifecycle) throw new Error("expected old restore options");
    oldRestore.managedEgressLifecycle.registerCallbackBinding(effective);

    const newRegistry = new ManagedEgressBindingRegistry();
    const newRestore = managedEgressRestoreOptions(persisted, expected, newRegistry);
    if (!newRestore?.managedEgress || !newRestore.managedEgressLifecycle) throw new Error("expected new restore options");
    expect(newRestore.managedEgress.proxyToken).not.toBe(oldRestore.managedEgress.proxyToken);
    expect(await newRegistry.authorize(oldRestore.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    newRestore.managedEgressLifecycle.registerCallbackBinding(effective);
    expect((await newRegistry.authorize(newRestore.managedEgress.proxyToken, authorizationRequest))?.decision).toBe("deny");
  });

  it("rotates by revoking the old binding before registering fresh material", async () => {
    const registry = new ManagedEgressBindingRegistry();
    const oldOptions = managedEgressRestoreOptions(persisted, expected, registry);
    if (!oldOptions?.managedEgress || !oldOptions.managedEgressLifecycle) throw new Error("expected old options");
    oldOptions.managedEgressLifecycle.registerCallbackBinding(effective);

    const freshOptions = managedEgressRestoreOptions(persisted, expected, registry);
    if (!freshOptions?.managedEgress || !freshOptions.managedEgressLifecycle) throw new Error("expected fresh options");
    oldOptions.managedEgressLifecycle.revokeCallbackBinding();
    expect(await registry.authorize(oldOptions.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    expect(await registry.authorize(freshOptions.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    freshOptions.managedEgressLifecycle.registerCallbackBinding(effective);
    expect((await registry.authorize(freshOptions.managedEgress.proxyToken, authorizationRequest))?.decision).toBe("deny");
  });

  it("fails closed without registry or with mismatched durable identity", () => {
    expect(() => managedEgressRestoreOptions(persisted, expected, undefined)).toThrow(ManagedEgressPrerequisiteError);
    expect(() => managedEgressRestoreOptions(persisted, { ...expected, sessionId: "other" }, new ManagedEgressBindingRegistry())).toThrow(ManagedEgressPrerequisiteError);
  });
});
