/**
 * Issue filing routes: exact status codes and bodies. The Security plugin
 * serves these routes; the legacy `/api/sessions/:id/security/...` URLs are
 * host-owned aliases (docs/plans/2026-10-09-security-plugin-adoption.md).
 * Every case runs against each URL form.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import linearPlugin from "@valet/plugin-linear/plugin";
import type { SecurityDigestIssueBody, SecurityFileIssueBody } from "@valet/plugin-security";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { eq } from "drizzle-orm";
import { orgMembers, securityFindingLinks, securityFindings } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityDigestIssueResponse,
  SecurityFileIssueResponse,
} from "../wire/types.js";

interface RouteForm {
  issue(sessionId: string, findingId: string): string;
  digest(sessionId: string): string;
}

const LEGACY: RouteForm = {
  issue: (sessionId, findingId) => `/api/sessions/${sessionId}/security/findings/${findingId}/issues`,
  digest: (sessionId) => `/api/sessions/${sessionId}/security/issues/digest`,
};

const CANONICAL: RouteForm = {
  issue: (sessionId, findingId) => `/api/plugins/security/http/sessions/${sessionId}/findings/${findingId}/issues`,
  digest: (sessionId) => `/api/plugins/security/http/sessions/${sessionId}/issues/digest`,
};

const ROUTE_FORMS: Array<[string, RouteForm]> = [["legacy", LEGACY], ["canonical", CANONICAL]];

const NO_ENGAGEMENT =
  "This session has no security engagement. Create the session with kind 'security' to start one.";
const HUMAN_ONLY =
  "This is a human action. Sign in and call it as a user — the internal token is refused here.";
const EVIDENCE =
  "The handler reads the session id from the URL and never checks ownership, so any caller reads any session. " +
  "Excerpt: db.select().from(sessions).where(eq(sessions.id, id)) returns the row without an owner filter.";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Stands in for plugin-github's create_issue behind the real action invoker. */
function fakeGithubPlugin(): { plugin: ValetPlugin; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const createIssue: PluginAction = {
    id: "github.create_issue",
    name: "Create issue",
    description: "Test fake of plugin-github's create_issue.",
    riskLevel: "low",
    parameters: Type.Object({ owner: Type.String(), repo: Type.String(), title: Type.String(), body: Type.String() }),
    execute: async (args) => {
      calls.push(typeof args === "object" && args !== null ? { ...args } : {});
      const number = 100 + calls.length;
      return { success: true, data: { number, html_url: `https://github.com/acme/api/issues/${number}` } };
    },
  };
  return { plugin: { name: "github", version: "0.0.1", actions: [{ service: "github", actions: [createIssue] }] }, calls };
}

async function createSession(baseUrl: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp/valet-security-issue-routes", ...body }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateSessionResponse).id;
}

async function createSecuritySession(target: TestApi): Promise<{ sessionId: string; engagementId: string }> {
  const sessionId = await createSession(target.baseUrl, {
    kind: "security",
    repo: { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" },
  });
  const res = await fetch(`${target.baseUrl}/api/sessions/${sessionId}/security`);
  expect(res.status).toBe(200);
  return { sessionId, engagementId: ((await res.json()) as GetSessionSecurityResponse).engagement.id };
}

async function seedFinding(target: TestApi, engagementId: string, id: string): Promise<void> {
  await target.providers.db.insert(securityFindings).values({
    id,
    engagementId,
    cellId: "cell_x",
    fingerprint: `fp_${id}`,
    severity: "high",
    title: `Finding ${id}`,
    file: "src/routes/sessions.ts",
    line: 42,
    body: EVIDENCE,
    status: "open",
    createdAt: 1_000,
  });
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await response.json()).toEqual({ error });
}

// The plugin shapes these bodies; the web client reads them as the wire types.
expectTypeOf<SecurityFileIssueBody>().toEqualTypeOf<SecurityFileIssueResponse>();
expectTypeOf<SecurityDigestIssueBody>().toEqualTypeOf<SecurityDigestIssueResponse>();

describe.each(ROUTE_FORMS)("security issue filing at the %s URL", (_name, routes) => {
  it("hides sessions the caller cannot view and names a missing engagement", async () => {
    const github = fakeGithubPlugin();
    api = await bootTestApi({ plugins: [github.plugin] });
    const { sessionId, engagementId } = await createSecuritySession(api);
    await seedFinding(api, engagementId, "fnd_1");
    const plainSessionId = await createSession(api.baseUrl, {});
    const issueBody = JSON.stringify({ provider: "github" });
    const digestBody = JSON.stringify({ provider: "github", findingIds: ["fnd_1"] });
    const base = api.baseUrl;

    await expectError(await post(`${base}${routes.issue("s_missing", "fnd_1")}`, issueBody), 404, "session not found");
    await expectError(await post(`${base}${routes.digest("s_missing")}`, digestBody), 404, "session not found");
    // A member of the same organization who does not own the session.
    const otherUser = { "x-valet-test-user-id": "test-member" };
    await expectError(await post(`${base}${routes.issue(sessionId, "fnd_1")}`, issueBody, otherUser), 404, "session not found");
    await expectError(await post(`${base}${routes.digest(sessionId)}`, digestBody, otherUser), 404, "session not found");
    await expectError(await post(`${base}${routes.issue(plainSessionId, "fnd_1")}`, issueBody), 404, NO_ENGAGEMENT);
    await expectError(await post(`${base}${routes.digest(plainSessionId)}`, digestBody), 404, NO_ENGAGEMENT);
    // The internal token is the sandbox tools' credential. Filing is human-only.
    const runner = { "x-valet-internal": internalToken(), "x-valet-session-id": sessionId };
    await expectError(await post(`${base}${routes.issue(sessionId, "fnd_1")}`, issueBody, runner), 403, HUMAN_ONLY);
    await expectError(await post(`${base}${routes.digest(sessionId)}`, digestBody, runner), 403, HUMAN_ONLY);

    expect(github.calls).toHaveLength(0);
    expect(await api.providers.db.select().from(securityFindingLinks)).toHaveLength(0);
  });

  it("validates the request body with the existing corrective messages", async () => {
    const github = fakeGithubPlugin();
    api = await bootTestApi({ plugins: [github.plugin, linearPlugin] });
    const a = await createSecuritySession(api);
    const b = await createSecuritySession(api);
    await seedFinding(api, a.engagementId, "fnd_a");
    await seedFinding(api, b.engagementId, "fnd_b");
    const issue = `${api.baseUrl}${routes.issue(a.sessionId, "fnd_a")}`;
    const digest = `${api.baseUrl}${routes.digest(a.sessionId)}`;
    const providerError = "provider must be 'github' or 'linear'.";
    const findingIdsError = "Send { findingIds } with at least one finding id.";

    await expectError(await post(issue, "{not json"), 400, providerError);
    await expectError(await post(issue, "[]"), 400, providerError);
    await expectError(await post(issue, JSON.stringify({ provider: "jira" })), 400, providerError);
    await expectError(await post(issue, JSON.stringify({ provider: "github", repo: 7 })), 400, "repo must be an owner/name string.");
    await expectError(await post(issue, JSON.stringify({ provider: "github", teamId: 7 })), 400, "teamId must be a Linear team id string.");
    await expectError(
      await post(`${api.baseUrl}${routes.issue(a.sessionId, "fnd_b")}`, JSON.stringify({ provider: "github" })),
      404,
      "No finding fnd_b in this engagement.",
    );
    await expectError(await post(issue, JSON.stringify({ provider: "linear" })), 400, "Pick a Linear team for this engagement.");
    await expectError(
      await post(issue, JSON.stringify({ provider: "linear", teamId: "SEC" })),
      400,
      "Connect the Linear integration in Settings.",
    );
    await expectError(
      await post(issue, JSON.stringify({ provider: "github", repo: "no-slash" })),
      400,
      'Repository "no-slash" is not owner/repo shaped. Send { repo } as "owner/name".',
    );

    await expectError(await post(digest, "{not json"), 400, providerError);
    await expectError(await post(digest, JSON.stringify({ provider: "github" })), 400, findingIdsError);
    await expectError(await post(digest, JSON.stringify({ provider: "github", findingIds: [] })), 400, findingIdsError);
    await expectError(await post(digest, JSON.stringify({ provider: "github", findingIds: [7] })), 400, findingIdsError);
    await expectError(
      await post(digest, JSON.stringify({ provider: "github", findingIds: ["fnd_a"], repo: 7 })),
      400,
      "repo must be an owner/name string.",
    );
    await expectError(
      await post(digest, JSON.stringify({ provider: "github", findingIds: ["fnd_a"], teamId: 7 })),
      400,
      "teamId must be a Linear team id string.",
    );
    await expectError(
      await post(digest, JSON.stringify({ provider: "github", findingIds: ["fnd_a", "fnd_b"] })),
      400,
      "Every finding in { findingIds } must belong to this engagement.",
    );

    expect(github.calls).toHaveLength(0);
    expect(await api.providers.db.select().from(securityFindingLinks)).toHaveLength(0);
  });

  it("files as the caller, returns the stored link on repeat, and files one digest", async () => {
    const github = fakeGithubPlugin();
    api = await bootTestApi({ plugins: [github.plugin] });
    const { sessionId, engagementId } = await createSecuritySession(api);
    await seedFinding(api, engagementId, "fnd_1");
    await seedFinding(api, engagementId, "fnd_2");
    const issue = `${api.baseUrl}${routes.issue(sessionId, "fnd_1")}`;
    // A foreign organization or user in the body cannot change the actor.
    const body = JSON.stringify({ provider: "github", orgId: "foreign", userId: "test-member" });

    const first = await post(issue, body);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^application\/json/);
    const firstBody = (await first.json()) as SecurityFileIssueResponse;
    expect(firstBody).toEqual({
      link: {
        id: expect.stringMatching(/^lnk_/),
        findingId: "fnd_1",
        provider: "github",
        externalId: "101",
        url: "https://github.com/acme/api/issues/101",
        createdBy: "local-user",
        createdAt: expect.any(Number),
      },
      created: true,
    });
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]).toMatchObject({ owner: "acme", repo: "api", title: expect.stringContaining("Finding fnd_1") });

    const repeat = await post(issue, body);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ link: firstBody.link, created: false });
    expect(github.calls).toHaveLength(1);

    const digest = await post(
      `${api.baseUrl}${routes.digest(sessionId)}`,
      JSON.stringify({ provider: "github", findingIds: ["fnd_1", "fnd_2", "fnd_1"], repo: "acme/tracker" }),
    );
    expect(digest.status).toBe(200);
    const digestBody: SecurityDigestIssueResponse = { url: "https://github.com/acme/api/issues/102" };
    expect(await digest.json()).toEqual(digestBody);
    expect(github.calls).toHaveLength(2);
    expect(github.calls[1]).toMatchObject({ owner: "acme", repo: "tracker" });
    expect(String(github.calls[1].body)).toContain("Finding fnd_2");
    expect(await api.providers.db.select().from(securityFindingLinks)).toHaveLength(1);
  });

  it("refuses oversized bodies and former organization members before filing", async () => {
    const github = fakeGithubPlugin();
    api = await bootTestApi({ plugins: [github.plugin] });
    const { sessionId, engagementId } = await createSecuritySession(api);
    await seedFinding(api, engagementId, "fnd_1");
    const issue = `${api.baseUrl}${routes.issue(sessionId, "fnd_1")}`;
    const digest = `${api.baseUrl}${routes.digest(sessionId)}`;

    const padding = "x".repeat(16 * 1024);
    await expectError(await post(issue, JSON.stringify({ provider: "github", padding })), 413, "payload too large");
    const manyIds = Array.from({ length: 30_000 }, (_, index) => `fnd_${index}`);
    await expectError(await post(digest, JSON.stringify({ provider: "github", findingIds: manyIds })), 413, "payload too large");

    // The route mount checks organization membership before session access.
    await api.providers.db.delete(orgMembers).where(eq(orgMembers.userId, "local-user"));
    const membership = "Organization membership required. Ask an administrator for access.";
    await expectError(await post(issue, JSON.stringify({ provider: "github" })), 403, membership);
    await expectError(await post(digest, JSON.stringify({ provider: "github", findingIds: ["fnd_1"] })), 403, membership);

    expect(github.calls).toHaveLength(0);
    expect(await api.providers.db.select().from(securityFindingLinks)).toHaveLength(0);
  });
});
