/**
 * `POST /api/sandbox/pull-request-requirement`: the org's signed pull request
 * rule for the sandbox `gh` shim. 204 for no rule, plain text otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions, orgs } from "../schema/index.js";
import { SIGNED_PULL_REQUESTS_RULE } from "../services/signed-pull-requests.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function ask(sessionId: string, withToken = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (withToken) {
    const { token } = await mintSandboxToken(api!.providers.db, { sessionId, userId: "local-user", orgId: "local-org" });
    headers["x-valet-sandbox"] = token;
  }
  return fetch(`${api!.baseUrl}/api/sandbox/pull-request-requirement`, { method: "POST", headers });
}

async function requireSigned(required: boolean): Promise<void> {
  await api!.providers.db.update(orgs).set({ requireSignedPullRequests: required }).where(eq(orgs.id, "local-org"));
}

describe("POST /api/sandbox/pull-request-requirement", () => {
  it("answers 204 when the org has no rule", async () => {
    api = await bootTestApi();
    const res = await ask("sess-pr-1");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers the rule and the next step as plain text when the org requires signed commits", async () => {
    api = await bootTestApi();
    await requireSigned(true);
    const res = await ask("sess-pr-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain(SIGNED_PULL_REQUESTS_RULE);
  });

  it("tells a team-owned session that no person can sign", async () => {
    api = await bootTestApi();
    await requireSigned(true);
    const db = api.providers.db;
    await db.insert(agentSessions).values({
      id: "sess-team", orgId: "local-org", userId: "local-user", ownerType: "team", ownerId: "team-1",
      workspace: "/workspace", createdAt: 1, updatedAt: 1,
    });
    expect(await (await ask("sess-team")).text()).toContain("No person can sign commits for this run.");
  });

  it("refuses a request without a sandbox token", async () => {
    api = await bootTestApi();
    expect((await ask("sess-pr-1", false)).status).toBe(401);
  });
});
