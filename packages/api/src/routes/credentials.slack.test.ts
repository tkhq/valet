/**
 * `PUT /api/credentials/slack` at org scope — the one service this route
 * checks before it stores. Every case here is a misconfiguration that is
 * otherwise invisible until the agent silently fails in a workspace.
 * Real HTTP against a fake Slack `auth.test` (`test-helpers/slack-fixture.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startSlackFixture, type SlackFixture } from "../test-helpers/slack-fixture.js";

let api: TestApi | undefined;
let slack: SlackFixture | undefined;
const savedApiBase = process.env.VALET_SLACK_API_BASE;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await slack?.close();
  slack = undefined;
  if (savedApiBase === undefined) delete process.env.VALET_SLACK_API_BASE;
  else process.env.VALET_SLACK_API_BASE = savedApiBase;
});

function useFixture(fixture: SlackFixture): void {
  slack = fixture;
  process.env.VALET_SLACK_API_BASE = fixture.url;
}

interface PutBody {
  type: "bot_token";
  accessToken: string;
  scope: "org" | "user";
  metadata?: Record<string, unknown>;
}

async function put(baseUrl: string, body: PutBody, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/credentials/slack`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function orgBody(overrides: Partial<PutBody> = {}): PutBody {
  return {
    type: "bot_token",
    accessToken: "xoxb-test-token",
    scope: "org",
    metadata: { webhookSecret: "signing-secret" },
    ...overrides,
  };
}

async function storedSlackCredential(a: TestApi) {
  return a.providers.engineCredentials.get({ type: "org", id: "local-org" }, "slack");
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
}

describe("PUT /api/credentials/slack?scope=org", () => {
  it("records the workspace identity and the granted scopes", async () => {
    api = await bootTestApi();
    useFixture(startSlackFixture());

    const res = await put(api.baseUrl, orgBody());
    expect(res.status).toBe(200);

    const stored = await storedSlackCredential(api);
    expect(stored?.metadata).toMatchObject({
      webhookSecret: "signing-secret",
      teamId: "T0FIXTURE",
      teamName: "Fixture Workspace",
      botUserId: "U0BOTFIXTURE",
    });
    expect(stored?.scopes).toContain("assistant:write");
    expect(slack?.calls).toEqual(["Bearer xoxb-test-token"]);
  });

  it("rejects a missing signing secret before it calls Slack", async () => {
    api = await bootTestApi();
    useFixture(startSlackFixture());

    const res = await put(api.baseUrl, orgBody({ metadata: {} }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("metadata.webhookSecret");
    // The message must name where to find it.
    expect(await storedSlackCredential(api)).toBeNull();
    expect(slack?.calls).toEqual([]);
  });

  it("rejects a token Slack itself rejects, and names the fix", async () => {
    api = await bootTestApi();
    useFixture(startSlackFixture({ body: { ok: false, error: "invalid_auth" } }));

    const res = await put(api.baseUrl, orgBody());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error).toContain("invalid_auth");
    expect(error).toContain("OAuth & Permissions");
    expect(await storedSlackCredential(api)).toBeNull();
  });

  it("rejects a user token, which would post as a human and cannot hold assistant:write", async () => {
    api = await bootTestApi();
    // A user token passes auth.test but carries no bot_id.
    useFixture(
      startSlackFixture({
        body: { ok: true, team: "Fixture Workspace", team_id: "T0FIXTURE", user: "grace", user_id: "W0HUMAN" },
        scopes: "assistant:write,chat:write,im:history",
      }),
    );

    const res = await put(api.baseUrl, orgBody({ accessToken: "xoxp-user-token" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("xoxb-");
    expect(await storedSlackCredential(api)).toBeNull();
  });

  it("rejects an install that never granted assistant:write, naming the missing scope", async () => {
    api = await bootTestApi();
    useFixture(
      startSlackFixture({
        body: { ok: true, team: "Fixture Workspace", team_id: "T0FIXTURE", user_id: "U0BOT", bot_id: "B0FIXTURE" },
        scopes: "chat:write,im:history",
      }),
    );

    const res = await put(api.baseUrl, orgBody());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error).toContain("assistant:write");
    expect(error).toContain("agent feature");
    expect(await storedSlackCredential(api)).toBeNull();
  });

  it("saves when Slack sends no scope header, because that is unknown and not empty", async () => {
    api = await bootTestApi();
    useFixture(
      startSlackFixture({
        body: { ok: true, team: "Fixture Workspace", team_id: "T0FIXTURE", user_id: "U0BOT", bot_id: "B0FIXTURE" },
      }),
    );

    const res = await put(api.baseUrl, orgBody());
    expect(res.status).toBe(200);
    const stored = await storedSlackCredential(api);
    expect(stored?.metadata?.teamId).toBe("T0FIXTURE");
    expect(stored?.scopes).toBeUndefined();
  });

  it("rejects a token with no workspace, which is what an org-wide install looks like", async () => {
    api = await bootTestApi();
    useFixture(
      startSlackFixture({
        body: { ok: true, user_id: "U0BOT", bot_id: "B0FIXTURE", enterprise_id: "E0GRID" },
        scopes: "assistant:write,chat:write,im:history",
      }),
    );

    const res = await put(api.baseUrl, orgBody());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("single workspace");
    expect(await storedSlackCredential(api)).toBeNull();
  });

  it("refuses a non-admin before it calls Slack", async () => {
    api = await bootTestApi();
    useFixture(startSlackFixture());

    const res = await put(api.baseUrl, orgBody(), { "x-valet-test-user-id": "test-member" });
    expect(res.status).toBe(403);
    expect(slack?.calls).toEqual([]);
    expect(await storedSlackCredential(api)).toBeNull();
  });

  it("leaves a personal slack token alone — the check is for the org credential only", async () => {
    api = await bootTestApi();
    useFixture(startSlackFixture());

    const res = await put(api.baseUrl, orgBody({ scope: "user", metadata: undefined }));
    expect(res.status).toBe(200);
    expect(slack?.calls).toEqual([]);
    const personal = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slack");
    expect(personal?.accessToken).toBe("xoxb-test-token");
  });
});
