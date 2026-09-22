import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { ManagedEgressBindingRegistry, managedEgressAuthorizationRouter, parseAuthorizationRequestV1 } from "./managed-egress-authorization.js";

const identity = { orgId: "org-1", sessionId: "session-1", workloadId: "workload-1", proxyId: "proxy-1", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION };
const token = "t".repeat(48);
const request = {
  version: "1", request_id: "request-1", service: "egress", action: "connect",
  subject: { session_id: "session-1", workload_id: "workload-1" },
  destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443 },
};

function post(body: unknown, bearer = token) {
  return managedEgressAuthorizationRouter(registry).request("/v1/authorize", {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
let registry: ManagedEgressBindingRegistry;

describe("managed egress callback", () => {
  it("strictly accepts only the Hematite v1 privacy schema", () => {
    expect(parseAuthorizationRequestV1(request)).not.toBeNull();
    for (const extra of ["method", "path", "query", "headers", "body", "sni", "resolved_ip", "client_address", "token", "credentials"]) {
      expect(parseAuthorizationRequestV1({ ...request, [extra]: "private" }), extra).toBeNull();
    }
  });

  it("authenticates the proxy token, binds identity, denies unsupported, and disables caches", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    const response = await post(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(await response.json()).toMatchObject({ version: "1", request_id: "request-1", decision: "deny", reason_code: "unsupported_prerequisite" });
    expect((await post(request, "x".repeat(48))).status).toBe(401);
    expect((await post({ ...request, subject: { ...request.subject, session_id: "caller-choice" } })).status).toBe(401);
  });

  it("keeps identity and token bindings one-to-one", () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    expect(() => registry.register({ ...identity, sessionId: "changed" }, "n".repeat(48))).toThrow(/already exists/);
    expect(() => registry.register({ ...identity, proxyId: "proxy-2" }, token)).toThrow(/already has a binding/);
  });

  it("handles replay deterministically and rotation revokes the old token", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    const first = await (await post(request)).json();
    const replay = await (await post(request)).json();
    expect(replay).toEqual(first);
    const replacement = "r".repeat(48); registry.rotate(identity.proxyId, replacement);
    expect((await post(request)).status).toBe(401);
    expect((await post(request, replacement)).status).toBe(200);
    registry.revoke(identity.proxyId);
    expect((await post(request, replacement)).status).toBe(401);
  });
});
