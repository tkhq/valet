import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationRequest, PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

function envelope(request: AuthorizationRequest, effect: "deny" | "require_approval"): PolicyDecisionEnvelope {
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

  it("protects the resolution endpoint without recursively requiring approval", async () => {
    api = await bootTestApi();
    const seen: string[] = [];
    const original = api.providers.canonicalAuthorizationService.authorize.bind(api.providers.canonicalAuthorizationService);
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request) => {
      seen.push(request.action.id);
      return original(request);
    });
    const response = await fetch(`${api.baseUrl}/api/authorization/decisions/missing/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, verdict: "approved" }),
    });
    expect(response.status).toBe(404);
    expect(seen).toEqual(["api_authorization.post_authorization_decisions_item_resolve"]);
  });
});
