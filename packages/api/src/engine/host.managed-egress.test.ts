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

const persisted: NonNullable<SessionData["managedEgress"]> = { requested: { identity } };
const authorizationRequest: AuthorizationRequestV1 = {
  version: "1",
  request_id: "request-1",
  service: "egress",
  action: "connect",
  subject: { session_id: identity.sessionId, workload_id: identity.workloadId },
  destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443 },
};

describe("managed egress restart options", () => {
  it("registers only after provider material delivery and revokes on loss", () => {
    const registry = new ManagedEgressBindingRegistry();
    const restored = managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, registry);
    if (!restored?.managedEgress || !restored.managedEgressLifecycle) throw new Error("expected managed restore options");

    expect(registry.authorize(restored.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    restored.managedEgressLifecycle.registerCallbackBinding();
    expect(registry.authorize(restored.managedEgress.proxyToken, authorizationRequest)?.decision).toBe("deny");
    restored.managedEgressLifecycle.revokeCallbackBinding();
    expect(registry.authorize(restored.managedEgress.proxyToken, authorizationRequest)).toBeNull();
  });

  it("mints a fresh process-epoch token and leaves the old registry unauthorized", () => {
    const oldRegistry = new ManagedEgressBindingRegistry();
    const oldRestore = managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, oldRegistry);
    if (!oldRestore?.managedEgress || !oldRestore.managedEgressLifecycle) throw new Error("expected old restore options");
    oldRestore.managedEgressLifecycle.registerCallbackBinding();

    const newRegistry = new ManagedEgressBindingRegistry();
    const newRestore = managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, newRegistry);
    if (!newRestore?.managedEgress || !newRestore.managedEgressLifecycle) throw new Error("expected new restore options");
    expect(newRestore.managedEgress.proxyToken).not.toBe(oldRestore.managedEgress.proxyToken);
    expect(newRegistry.authorize(oldRestore.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    newRestore.managedEgressLifecycle.registerCallbackBinding();
    expect(newRegistry.authorize(newRestore.managedEgress.proxyToken, authorizationRequest)?.decision).toBe("deny");
  });

  it("rotates by revoking the old binding before registering fresh delivered material", () => {
    const registry = new ManagedEgressBindingRegistry();
    const oldOptions = managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, registry);
    if (!oldOptions?.managedEgress || !oldOptions.managedEgressLifecycle) throw new Error("expected old options");
    oldOptions.managedEgressLifecycle.registerCallbackBinding();

    const freshOptions = managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, registry);
    if (!freshOptions?.managedEgress || !freshOptions.managedEgressLifecycle) throw new Error("expected fresh options");
    oldOptions.managedEgressLifecycle.revokeCallbackBinding();
    expect(registry.authorize(oldOptions.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    expect(registry.authorize(freshOptions.managedEgress.proxyToken, authorizationRequest)).toBeNull();
    freshOptions.managedEgressLifecycle.registerCallbackBinding();
    expect(registry.authorize(freshOptions.managedEgress.proxyToken, authorizationRequest)?.decision).toBe("deny");
  });

  it("fails closed without registry or with mismatched durable identity", () => {
    expect(() => managedEgressRestoreOptions(persisted, { sessionId: identity.sessionId, orgId: identity.orgId }, undefined)).toThrow(ManagedEgressPrerequisiteError);
    expect(() => managedEgressRestoreOptions(persisted, { sessionId: "other", orgId: identity.orgId }, new ManagedEgressBindingRegistry())).toThrow(ManagedEgressPrerequisiteError);
  });
});
