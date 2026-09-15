import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationRequest, PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { ResourceAuthorizationError } from "./resource-authorization.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, workflowDefinitions } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

function envelope(request: AuthorizationRequest, effect: "allow" | "deny" | "require_approval"): PolicyDecisionEnvelope {
  const digest = "0".repeat(64);
  return {
    schemaVersion: 1, requestId: request.requestId, requestSubjectDigest: digest, inputDigest: digest,
    policyDigest: digest, sourceBundleDigest: digest, evaluator: { kind: "local_valet", engineDigest: digest },
    decision: { effect, reasonCode: "test", matchedRuleIds: [], obligations: [], redactions: [], ...(effect === "require_approval" ? { approvalRequirement: { tier: "human", approverType: "org", replay: "once" } as const } : {}) },
    decisionDigest: digest, obligationDigest: digest, evaluatedAtMs: 1,
  };
}

async function postSession(): Promise<Response> {
  return fetch(`${api!.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "/tmp" }) });
}

describe("route authorization middleware", () => {
  it.each([
    ["deny", 403, "authorization_denied"],
    ["require_approval", 428, "authorization_idempotency_required"],
    ["throw", 503, "authorization_indeterminate"],
  ] as const)("blocks %s before the handler", async (result, status, code) => {
    api = await bootTestApi();
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request) => {
      if (result === "throw") throw new Error("evaluator unavailable");
      return envelope(request, result);
    });
    const response = await postSession();
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(await api.providers.db.select().from(agentSessions)).toHaveLength(0);
  });

  it("denies recursive approval on the resolution endpoint", async () => {
    api = await bootTestApi();
    const seen: string[] = [];
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request) => {
      seen.push(request.action.id);
      return envelope(request, "require_approval");
    });
    const response = await fetch(`${api.baseUrl}/api/authorization/decisions/missing/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ schemaVersion: 1, verdict: "approved" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "authorization_recursive_approval" });
    expect(seen).toEqual(["api_authorization.post_authorization_decisions_item_resolve"]);
  });

  it.each([
    ["deny", "allow", false],
    ["allow", "deny", false],
    ["require_approval", "allow", false],
    ["allow", "require_approval", false],
    ["allow", "allow", true],
  ] as const)("composes route %s and resource %s independently", async (routeEffect, resourceEffect, created) => {
    api = await bootTestApi();
    const original = api.providers.canonicalAuthorizationService.authorize.bind(api.providers.canonicalAuthorizationService);
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request) => routeEffect === "allow" ? original(request) : envelope(request, routeEffect));
    vi.spyOn(api.providers.resourceAuthorizationPort, "authorize").mockImplementation(async () => {
      if (resourceEffect !== "allow") throw new ResourceAuthorizationError(resourceEffect);
      return { schemaVersion: 1, readOnly: false, redactions: [] };
    });
    const response = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ name: "Composed", definition: { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }], edges: [] } }),
    });
    expect(response.ok).toBe(created);
    expect(await api.providers.db.select().from(workflowDefinitions)).toHaveLength(created ? 1 : 0);
  });

});
