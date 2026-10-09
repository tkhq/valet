/**
 * HTTP parity for Slack setup and signed ingress. Each case pins the status,
 * body and headers that Slack and the web client depend on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDropLog, slackWebhookInbox } from "../schema/index.js";
import { __resetSlackWebhookThrottle } from "../routes/slack-webhook.js";
import type { CreateTeamApiKeyResponse, CreateTeamResponse } from "../wire/types.js";

const INGRESS_PATHS = ["/api/channels/slack/webhook"];
const SETUP_PATHS = ["/api/org/slack"];
const SECRET = "slack-signing-secret";
const TEAM_ID = "T0001";

let api: TestApi | undefined;
const savedPublicUrl = process.env.VALET_PUBLIC_URL;

beforeEach(() => {
  // The real transport must never call Slack from a test.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === "slack.com") return Promise.resolve(Response.json({ ok: false, error: "invalid_auth" }));
    return realFetch(input, init);
  });
  __resetSlackWebhookThrottle();
});

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.restoreAllMocks();
  if (savedPublicUrl === undefined) delete process.env.VALET_PUBLIC_URL;
  else process.env.VALET_PUBLIC_URL = savedPublicUrl;
});

function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return { "content-type": "application/json", "x-slack-signature": `v0=${digest}`, "x-slack-request-timestamp": String(timestamp) };
}

function envelope(eventId: string): string {
  return JSON.stringify({
    token: "ignored", api_app_id: "A001", type: "event_callback", team_id: TEAM_ID, event_id: eventId,
    event: { type: "reaction_added", user: "U100", reaction: "tada", item: { type: "message", channel: "C500", ts: "1.1" }, event_ts: "1.2" },
  });
}

async function connect(a: TestApi, start = true): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token", accessToken: "xoxb-test-token",
    metadata: { webhookSecret: SECRET, teamId: TEAM_ID, botUserId: "U0BOT", botId: "BVALET" },
  });
  if (start) await a.providers.channelHost.start();
}

async function dropReasons(a: TestApi): Promise<string[]> {
  return (await a.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"))).map((row) => row.reason);
}

describe.each(INGRESS_PATHS)("Slack ingress at %s", (path) => {
  const post = (body: string, headers: Record<string, string>) =>
    fetch(`${api!.baseUrl}${path}`, { method: "POST", headers, body });

  it("answers the URL verification challenge before a credential exists", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const res = await post(JSON.stringify({ type: "url_verification", challenge: "ch-123" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ challenge: "ch-123" });
    expect(await dropReasons(api)).toEqual([]);
  });

  it("refuses to reflect an over-long challenge", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const res = await post(JSON.stringify({ type: "url_verification", challenge: "x".repeat(513) }), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "challenge too long" });
  });

  it("acknowledges with an empty body when Slack is not connected", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const body = envelope("Ev-unconfigured");
    const res = await post(body, signed(body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await dropReasons(api)).toEqual(["unknown_org"]);
  });

  it("asks Slack to retry while the transport is stopped", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await connect(api, false);
    const body = envelope("Ev-starting");
    const res = await post(body, signed(body));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: "Slack is starting. Retry this delivery shortly." });
    expect(await api.providers.db.select().from(slackWebhookInbox)).toEqual([]);
  });

  it.each([
    ["a wrong secret", (body: string) => signed(body, "wrong-secret")],
    ["a stale timestamp", (body: string) => signed(body, SECRET, Math.floor(Date.now() / 1000) - 301)],
    ["no signature", () => ({ "content-type": "application/json" })],
  ])("rejects %s with 401 and admits nothing", async (_label, headers) => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await connect(api);
    const body = envelope("Ev-rejected");
    const res = await post(body, headers(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature verification failed" });
    expect(await dropReasons(api)).toEqual(["bad_signature"]);
    expect(await api.providers.db.select().from(slackWebhookInbox)).toEqual([]);
  });

  it("rejects an oversized body by declared length and by streamed bytes", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await connect(api);
    const declared = await post(JSON.stringify({ pad: "x".repeat(1024 * 1024) }), { "content-type": "application/json" });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "payload too large" });
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 1024 * 1024 + chunk.byteLength) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    // Node requires duplex for a streamed request body.
    const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } };
    const streamed = await fetch(`${api.baseUrl}${path}`, init);
    expect(streamed.status).toBe(413);
    expect(await api.providers.db.select().from(slackWebhookInbox)).toEqual([]);
  });

  it("admits a verified delivery once across Slack retries and acknowledges with an empty body", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await connect(api);
    await api.providers.eventDispatcher.stop();
    const body = envelope("Ev-admitted");
    const first = await post(body, signed(body));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("");
    const retry = await post(body, { ...signed(body), "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("");
    const rows = await api.providers.db.select().from(slackWebhookInbox);
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe("local-org");
    expect(rows[0].payload).not.toContain("Ev-admitted");
    await expect.poll(() => dropReasons(api!), { timeout: 5_000 }).toContain("slack_retry");
  });

  it("admits a signed interactivity form", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    await connect(api);
    await api.providers.eventDispatcher.stop();
    const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: TEAM_ID }, actions: [] }))}`;
    const res = await post(body, { ...signed(body), "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(200);
    expect(await api.providers.db.select().from(slackWebhookInbox)).toHaveLength(1);
  });
});

describe.each(SETUP_PATHS)("Slack setup at %s", (path) => {
  it("returns the manifest and connection state to an administrator", async () => {
    process.env.VALET_PUBLIC_URL = "https://valet.example.com";
    api = await bootTestApi({ plugins: [slackPlugin] });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "xoxb-test-token", scopes: ["assistant:write", "chat:write", "im:history", "users:read"],
      metadata: { webhookSecret: SECRET, teamId: TEAM_ID, teamName: "Acme" },
    });
    const res = await fetch(`${api.baseUrl}${path}?name=%20Valet%20Dev%20`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      ingress: "webhook",
      requestUrl: "https://valet.example.com/api/channels/slack/webhook",
      createUrl: "https://api.slack.com/apps?new_app=1",
      requiredScopes: ["assistant:write", "chat:write", "im:history"],
      connected: true, teamName: "Acme", teamId: TEAM_ID,
      manifest: {
        display_information: { name: "Valet Dev" },
        oauth_config: { redirect_urls: ["https://valet.example.com/api/credentials/oauth/callback"] },
        settings: { socket_mode_enabled: false, interactivity: { is_enabled: true, request_url: "https://valet.example.com/api/channels/slack/webhook" } },
      },
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain("xoxb-test-token");
  });

  it("refuses a member who is not an administrator", async () => {
    api = await bootTestApi({ plugins: [slackPlugin] });
    const res = await fetch(`${api.baseUrl}${path}`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("refuses anonymous callers and team API keys", async () => {
    api = await bootTestApi({ plugins: [slackPlugin], auth: true });
    expect((await fetch(`${api.baseUrl}${path}`)).status).toBe(401);
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "slack-admin@nowhere.test", name: "Admin", password: "correct-horse-battery" }),
    });
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing session cookie");
    // These casts describe fixture responses from the real team-key endpoints.
    const team = await (await fetch(`${api.baseUrl}/api/teams`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Slack team" }),
    })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "CI" }),
    })).json() as CreateTeamApiKeyResponse;
    expect((await fetch(`${api.baseUrl}${path}`, { headers: { "x-api-key": key.key } })).status).toBe(403);
    expect((await fetch(`${api.baseUrl}${path}`, { headers: { cookie } })).status).toBe(200);
  });
});
