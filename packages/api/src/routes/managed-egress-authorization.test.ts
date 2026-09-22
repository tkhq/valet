import { describe, expect, it, vi } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { requestSubjectDigest } from "@valet/engine/authorization";
import { MANAGED_EGRESS_MAX_BODY_BYTES, ManagedEgressBindingRegistry, managedEgressAuthorizationRouter, parseAuthorizationRequestV1, type AuthorizationRequestV1 } from "./managed-egress-authorization.js";

const identity = { orgId: "org-1", sessionId: "session-1", workloadId: "workload-1", proxyId: "proxy-1", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION };
const token = "t".repeat(48);
const activation = {
  effective: {
    requested: true as const, configured: true as const, ready: true as const, effective: true as const,
    identity, proxyArtifact: "hematite@sha256:test",
    topology: { proxyResources: ["proxy-1"], policyResources: ["policy-1"], workloadSelector: { session: "session-1" }, callbackBindingId: "proxy-1" },
  },
  policyIdentity: { actorUserId: "server-user", principal: { type: "user" as const, id: "server-user" } },
};
const request: AuthorizationRequestV1 = {
  version: "1", request_id: "request-1", service: "egress", action: "connect",
  subject: { session_id: "session-1", workload_id: "workload-1" },
  destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443 },
};

let registry: ManagedEgressBindingRegistry;

function router(timeoutMs = 100) {
  return managedEgressAuthorizationRouter(registry, { bodyReadTimeoutMs: timeoutMs });
}

function post(body: unknown, bearer = token) {
  return router().request("/v1/authorize", {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  };
  return new Request("http://localhost/v1/authorize", init);
}

describe("managed egress callback", () => {
  it("strictly accepts only the Hematite v1 privacy schema", () => {
    expect(parseAuthorizationRequestV1(request)).not.toBeNull();
    for (const extra of ["method", "path", "query", "headers", "body", "sni", "resolved_ip", "client_address", "token", "credentials"]) {
      expect(parseAuthorizationRequestV1({ ...request, [extra]: "private" }), extra).toBeNull();
    }
    expect(parseAuthorizationRequestV1({ ...request, destination: { ...request.destination, host: "h".repeat(253) } })).not.toBeNull();
    expect(parseAuthorizationRequestV1({ ...request, destination: { ...request.destination, host: "h".repeat(254) } })).toBeNull();
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

  it("uses the canonical evaluator with server-bound identity after observing the boundary", async () => {
    const authorize = vi.fn(async (canonicalRequest: Parameters<import("../authorization/canonical-authorization-service.js").CanonicalAuthorizationService["authorize"]>[0]) => ({
      schemaVersion: 1 as const,
      requestId: canonicalRequest.requestId,
      requestSubjectDigest: requestSubjectDigest(canonicalRequest),
      inputDigest: "a".repeat(64), policyDigest: "b".repeat(64), sourceBundleDigest: "c".repeat(64),
      evaluator: { kind: "local_valet" as const, engineDigest: "d".repeat(64) },
      decision: { effect: "allow" as const, reasonCode: "organization_policy", matchedRuleIds: ["egress-rule"], obligations: [], redactions: [] },
      decisionDigest: "e".repeat(64), obligationDigest: "f".repeat(64), evaluatedAtMs: 100,
    }));
    registry = new ManagedEgressBindingRegistry({ authorization: { authorize }, now: () => 100 });
    registry.register(identity, token, undefined, 90, activation);

    const response = await post({ ...request, destination: { ...request.destination, host: "EXAMPLE.com." } });

    expect(await response.json()).toMatchObject({ decision: "allow", reason_code: "policy_allow" });
    expect(authorize).toHaveBeenCalledTimes(1);
    const canonicalRequest = authorize.mock.calls[0][0];
    expect(canonicalRequest.subject).toMatchObject({ orgId: "org-1", actorUserId: "server-user", principal: { type: "user", id: "server-user" }, sessionId: "session-1" });
    expect(canonicalRequest.action.parameters).toEqual({ destination: { scheme: "https", protocol: "tcp", host: "example.com", port: 443, destinationClass: "external" } });
  });

  it("validates method, media type, framing, and bearer length before reading", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, "x".repeat(4096));
    expect((await router().request("/v1/authorize", { method: "GET" })).status).toBe(405);
    expect((await router().request("/v1/authorize", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    for (const length of ["-1", "1, 2", "nope", String(MANAGED_EGRESS_MAX_BODY_BYTES + 1)]) {
      const response = await router().request(streamRequest(new ReadableStream({ start(controller) { controller.close(); } }), { "content-length": length }));
      expect(response.status, length).toBe(400);
      expect(response.headers.get("cache-control"), length).toContain("no-store");
    }
    const oversizedRequest = streamRequest(new ReadableStream({ start(controller) { controller.close(); } }), {
      "content-length": String(MANAGED_EGRESS_MAX_BODY_BYTES + 1),
    });
    const bodyLock = oversizedRequest.body?.getReader();
    expect((await router().request(oversizedRequest)).status).toBe(400);
    bodyLock?.releaseLock();
    const smuggled = await router().request(streamRequest(new ReadableStream({ start(controller) { controller.close(); } }), { "content-length": "0", "transfer-encoding": "chunked" }));
    expect(smuggled.status).toBe(400);
    const validBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(request))); controller.close(); } });
    const accepted = await router().request(streamRequest(validBody, { authorization: `Bearer ${"x".repeat(4096)}` }));
    expect(accepted.status).toBe(200);

    const exactUtf8Token = "é".repeat(2048);
    registry = new ManagedEgressBindingRegistry();
    registry.register(identity, exactUtf8Token);
    expect((await post(request, exactUtf8Token)).status).toBe(200);
    expect((await post(request, `${exactUtf8Token}é`)).status).toBe(401);
  });

  it("accepts an exact 4 KiB body", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    const json = JSON.stringify(request);
    const exact = `${json}${" ".repeat(MANAGED_EGRESS_MAX_BODY_BYTES - Buffer.byteLength(json))}`;
    const response = await router().request(streamRequest(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(exact)); controller.close(); } }), { "content-length": String(MANAGED_EGRESS_MAX_BODY_BYTES) }));
    expect(response.status).toBe(200);
  });

  it("cancels a lazy 200 MB-style chunked stream after bounded consumption", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    let consumed = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (consumed >= 200 * 1024 * 1024) return controller.close();
        consumed += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() { cancelled = true; },
    });
    const response = await router().request(streamRequest(stream, { "transfer-encoding": "chunked" }));
    expect(response.status).toBe(400);
    expect(consumed).toBeLessThanOrEqual(6 * 1024);
    expect(cancelled).toBe(true);
  });

  it("times out concurrent slow and never-ending streams", async () => {
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token);
    let cancellations = 0;
    const slow = () => new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel() { cancellations++; } });
    const started = Date.now();
    const responses = await Promise.all(Array.from({ length: 8 }, () => router(20).request(streamRequest(slow(), { "transfer-encoding": "chunked" }))));
    expect(responses.every((response) => response.status === 408)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(cancellations).toBe(8);
  });

  it("prunes bindings and enforces global and per-org caps", () => {
    registry = new ManagedEgressBindingRegistry({ maxBindings: 2, maxBindingsPerOrg: 1 });
    registry.register(identity, token, 20, 10);
    expect(() => registry.register({ ...identity, proxyId: "proxy-2" }, "u".repeat(48), undefined, 10)).toThrow(/organization capacity/);
    registry.prune(20);
    registry.register({ ...identity, proxyId: "proxy-2" }, token, undefined, 20);
    registry.register({ ...identity, orgId: "org-2", proxyId: "proxy-3" }, "v".repeat(48), undefined, 20);
    expect(() => registry.register({ ...identity, orgId: "org-3", proxyId: "proxy-4" }, "w".repeat(48), undefined, 20)).toThrow(/registry capacity/);
    expect(registry.bindingCount).toBe(2);
  });

  it("keeps rotate, expiry, registration, and replay deterministic", async () => {
    const now = Date.now();
    registry = new ManagedEgressBindingRegistry(); registry.register(identity, token, now + 100, now);
    const first = await (await post(request)).json();
    expect(await (await post(request)).json()).toEqual(first);
    const replacement = "r".repeat(48); registry.rotate(identity.proxyId, replacement, now + 50);
    expect((await post(request)).status).toBe(401);
    expect((await post(request, replacement)).status).toBe(200);
    registry.prune(now + 100);
    registry.register({ ...identity, proxyId: "proxy-2" }, replacement, undefined, now + 100);
    registry.revoke("proxy-2");
    registry.register({ ...identity, proxyId: "proxy-3" }, replacement, undefined, now + 100);
  });

  it("keeps concurrent replay, rotation, expiry, and registration bounded", async () => {
    const now = Date.now();
    const replacement = "r".repeat(48);
    registry = new ManagedEgressBindingRegistry({ maxBindings: 2, maxBindingsPerOrg: 2 });
    registry.register(identity, token, now + 10, now);

    const replayRequests = Array.from({ length: 64 }, async () => registry.authorize(token, request, now));
    const replayResponses = await Promise.all(replayRequests);
    expect(new Set(replayResponses.map((response) => response?.decision_id))).toHaveLength(1);

    await Promise.all([
      Promise.resolve().then(() => registry.rotate(identity.proxyId, replacement, now + 1)),
      Promise.resolve().then(() => registry.prune(now + 10)),
    ]);
    expect(registry.bindingCount).toBe(0);
    expect(await registry.authorize(token, request, now + 10)).toBeNull();
    expect(await registry.authorize(replacement, request, now + 10)).toBeNull();

    const registrations = await Promise.allSettled([
      Promise.resolve().then(() => registry.register({ ...identity, proxyId: "proxy-2" }, replacement, undefined, now + 10)),
      Promise.resolve().then(() => registry.register({ ...identity, proxyId: "proxy-3" }, replacement, undefined, now + 10)),
    ]);
    expect(registrations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(registrations.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(registry.bindingCount).toBe(1);
  });
});
