import { describe, expect, it } from "vitest";
import { validatePluginHttpRoutes, type PluginHttpCaller, type PluginHttpRequest, type PluginHttpRoute } from "@valet/engine";
import {
  handleFindingIssue,
  handleIssueDigest,
  securityHttpRoutes,
  type SecurityDigestIssueResult,
  type SecurityEngagementIssues,
  type SecurityFindingIssueResult,
  type SecurityFindingLink,
  type SecurityIssuesCapability,
} from "./http.js";
import plugin from "./plugin.js";

const caller: PluginHttpCaller = { userId: "u_1", orgId: "o_1" };
const LINK: SecurityFindingLink = {
  id: "lnk_1", findingId: "fnd_1", provider: "github", externalId: "9",
  url: "https://github.com/acme/api/issues/9", createdBy: "u_1", createdAt: 5,
};

function route(id: string): PluginHttpRoute {
  const found = securityHttpRoutes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing route ${id}`);
  return found;
}

function request(params: Record<string, string>, body: string): PluginHttpRequest {
  return {
    url: "https://valet.test/x", headers: {}, params,
    rawBody: new TextEncoder().encode(body), signal: new AbortController().signal,
  };
}

const HANDLERS = { "finding-issue": handleFindingIssue, "issue-digest": handleIssueDigest } as const;

/** Calls the exported handler that the host binds to this route ID. */
async function call(
  id: keyof typeof HANDLERS, req: PluginHttpRequest, capability: SecurityIssuesCapability,
): Promise<{ status: number; body: unknown }> {
  const response = await HANDLERS[id](req, capability);
  return { status: response.status, body: await response.json() };
}

function engagement(results: {
  finding?: SecurityFindingIssueResult;
  digest?: SecurityDigestIssueResult;
}): SecurityEngagementIssues & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async fileFindingIssue(input) {
      inputs.push(input);
      return results.finding ?? { outcome: "filed", link: LINK, created: true };
    },
    async fileDigestIssue(input) {
      inputs.push(input);
      return results.digest ?? { outcome: "filed", url: "https://github.com/acme/api/issues/10" };
    },
  };
}

describe("security HTTP routes", () => {
  it("declares valid user routes in the manifest", () => {
    expect(validatePluginHttpRoutes(securityHttpRoutes)).toEqual([]);
    expect(plugin.httpRoutes).toBe(securityHttpRoutes);
    expect(securityHttpRoutes.map(({ id, method, path, auth, maxBodyBytes }) => ({ id, method, path, auth, maxBodyBytes }))).toEqual([
      { id: "finding-issue", method: "POST", path: "/sessions/:id/findings/:findingId/issues", auth: "user", maxBodyBytes: 16 * 1024 },
      { id: "issue-digest", method: "POST", path: "/sessions/:id/issues/digest", auth: "user", maxBodyBytes: 256 * 1024 },
    ]);
  });

  it("fails closed on a host without the Security bindings", async () => {
    const req = request({ id: "s_1", findingId: "fnd_1" }, JSON.stringify({ provider: "github" }));
    const declared = route("finding-issue");
    if (declared.auth !== "user") throw new Error("finding-issue must use user authentication");
    const response = await declared.handle(req, caller);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 501,
      body: { error: "This Security route needs host capabilities. Run the bundled Security plugin in the Valet API." },
    });
  });

  it("names a missing engagement before it reads the body", async () => {
    const req = request({ id: "s_1" }, "{not json");
    expect(await call("issue-digest", req, { engagement: null })).toEqual({
      status: 404,
      body: { error: "This session has no security engagement. Create the session with kind 'security' to start one." },
    });
  });

  it("passes only the parsed target and path finding to the capability", async () => {
    const issues = engagement({});
    const req = request(
      { id: "s_1", findingId: "fnd_1" },
      JSON.stringify({ provider: "linear", teamId: "SEC", userId: "someone-else", orgId: "foreign" }),
    );
    expect(await call("finding-issue", req, { engagement: issues })).toEqual({ status: 200, body: { link: LINK, created: true } });
    expect(issues.inputs).toEqual([{ provider: "linear", teamId: "SEC", findingId: "fnd_1" }]);
  });

  it("removes duplicate digest IDs and maps every outcome to the existing status", async () => {
    const digest = engagement({});
    const ok = request({ id: "s_1" }, JSON.stringify({ provider: "github", findingIds: ["a", "b", "a"], repo: "acme/x" }));
    expect(await call("issue-digest", ok, { engagement: digest })).toEqual({ status: 200, body: { url: "https://github.com/acme/api/issues/10" } });
    expect(digest.inputs).toEqual([{ provider: "github", repo: "acme/x", findingIds: ["a", "b"] }]);

    const findingCases: Array<[SecurityFindingIssueResult, number, string]> = [
      [{ outcome: "unknown-finding" }, 404, "No finding fnd_1 in this engagement."],
      [{ outcome: "refused", message: "Connect the GitHub integration in Settings." }, 400, "Connect the GitHub integration in Settings."],
      [{ outcome: "failed", message: "GitHub is down." }, 502, "GitHub is down."],
    ];
    for (const [finding, status, message] of findingCases) {
      const req = request({ id: "s_1", findingId: "fnd_1" }, JSON.stringify({ provider: "github" }));
      expect(await call("finding-issue", req, { engagement: engagement({ finding }) })).toEqual({ status, body: { error: message } });
    }
    const digestCases: Array<[SecurityDigestIssueResult, number, string]> = [
      [{ outcome: "foreign-findings" }, 400, "Every finding in { findingIds } must belong to this engagement."],
      [{ outcome: "refused", message: "Pick a Linear team for this engagement." }, 400, "Pick a Linear team for this engagement."],
      [{ outcome: "failed", message: "Linear is down." }, 502, "Linear is down."],
    ];
    for (const [result, status, message] of digestCases) {
      const req = request({ id: "s_1" }, JSON.stringify({ provider: "github", findingIds: ["fnd_1"] }));
      expect(await call("issue-digest", req, { engagement: engagement({ digest: result }) })).toEqual({ status, body: { error: message } });
    }
  });

  it("refuses malformed bodies without calling the capability", async () => {
    const bodies: Array<[keyof typeof HANDLERS, string, string]> = [
      ["finding-issue", "{not json", "provider must be 'github' or 'linear'."],
      ["finding-issue", "[]", "provider must be 'github' or 'linear'."],
      ["finding-issue", JSON.stringify({ provider: "github", repo: 1 }), "repo must be an owner/name string."],
      ["finding-issue", JSON.stringify({ provider: "github", teamId: 1 }), "teamId must be a Linear team id string."],
      ["issue-digest", JSON.stringify({ provider: "github", findingIds: [] }), "Send { findingIds } with at least one finding id."],
      ["issue-digest", JSON.stringify({ provider: "github", findingIds: [1] }), "Send { findingIds } with at least one finding id."],
    ];
    for (const [id, body, message] of bodies) {
      const issues = engagement({});
      const req = request({ id: "s_1", findingId: "fnd_1" }, body);
      expect(await call(id, req, { engagement: issues })).toEqual({ status: 400, body: { error: message } });
      expect(issues.inputs).toEqual([]);
    }
  });
});
