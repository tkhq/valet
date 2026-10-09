import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validatePluginHttpRoutes, type PluginHttpRequest } from "@valet/engine";
import {
  handleSlackApp,
  handleSlackEvents,
  slackHttpRoutes,
  type SlackIngressCapability,
  type SlackIngressConnection,
  type SlackSetupCapability,
} from "./http.js";
import { SLACK_OPTIONAL_BOT_SCOPES } from "./app-manifest.js";

const SECRET = "signing-secret";

function request(body: string, headers: Record<string, string> = {}, url = "https://valet.test/plugins/slack/http/events"): PluginHttpRequest {
  return { url, headers, params: {}, rawBody: new TextEncoder().encode(body), signal: new AbortController().signal };
}

function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return { "x-slack-signature": `v0=${digest}`, "x-slack-request-timestamp": String(timestamp) };
}

function ingress(connection: SlackIngressConnection = { state: "ready", signingSecret: SECRET }) {
  const capability = {
    connection: vi.fn(async () => connection),
    report: vi.fn(async () => undefined),
    admit: vi.fn(async () => undefined),
  } satisfies SlackIngressCapability;
  return capability;
}

describe("Slack events route", () => {
  it("answers the handshake without reading the connection", async () => {
    const host = ingress();
    const res = await handleSlackEvents(request(JSON.stringify({ type: "url_verification", challenge: "abc" })), host);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc" });
    expect(host.connection).not.toHaveBeenCalled();
    const long = await handleSlackEvents(request(JSON.stringify({ type: "url_verification", challenge: "x".repeat(513) })), host);
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "challenge too long" });
  });

  it("acknowledges an unconfigured organization and asks for retry while starting", async () => {
    const body = "{}";
    const unconfigured = ingress({ state: "unconfigured" });
    const ack = await handleSlackEvents(request(body, signed(body)), unconfigured);
    expect(ack.status).toBe(200);
    expect(await ack.text()).toBe("");
    expect(unconfigured.report).toHaveBeenCalledWith(expect.objectContaining({ reason: "unknown_org" }));
    expect(unconfigured.admit).not.toHaveBeenCalled();

    const starting = ingress({ state: "starting" });
    const retry = await handleSlackEvents(request(body, signed(body)), starting);
    expect(retry.status).toBe(503);
    expect(retry.headers.get("retry-after")).toBe("5");
    expect(starting.report).toHaveBeenCalledWith(expect.objectContaining({ reason: "transport_unavailable" }));
    expect(starting.admit).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong secret", () => signed("{}", "other")],
    ["a stale timestamp", () => signed("{}", SECRET, Math.floor(Date.now() / 1000) - 301)],
    ["a crafted multibyte signature", () => ({ "x-slack-signature": `v0=${"0".repeat(63)}é`, "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) })],
    ["missing headers", () => ({})],
  ])("rejects %s with 401 and admits nothing", async (_label, headers) => {
    const host = ingress();
    const res = await handleSlackEvents(request("{}", headers()), host);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature verification failed" });
    expect(host.report).toHaveBeenCalledWith(expect.objectContaining({ reason: "bad_signature" }));
    expect(host.admit).not.toHaveBeenCalled();
  });

  it("admits a verified envelope with retry metadata and reports the retry", async () => {
    const host = ingress();
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "app_mention" } });
    const res = await handleSlackEvents(request(body, { ...signed(body), "x-slack-retry-num": "2", "x-slack-retry-reason": "http_timeout" }), host);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(host.admit).toHaveBeenCalledWith({ updates: [JSON.parse(body)], retryNum: "2", retryReason: "http_timeout" });
    expect(host.report).toHaveBeenCalledWith(expect.objectContaining({ reason: "slack_retry" }));
  });

  it("normalizes malformed retry headers and parses interactivity forms", async () => {
    const host = ingress();
    const payload = { type: "block_actions", team: { id: "T1" } };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    await handleSlackEvents(request(body, { ...signed(body), "x-slack-retry-num": "x", "x-slack-retry-reason": "<script>" }), host);
    expect(host.admit).toHaveBeenCalledWith({ updates: [payload], retryNum: "unknown", retryReason: "unknown" });
    const fresh = ingress();
    await handleSlackEvents(request(body, signed(body)), fresh);
    expect(fresh.admit).toHaveBeenCalledWith({ updates: [payload], retryNum: undefined, retryReason: "unknown" });
    expect(fresh.report).not.toHaveBeenCalled();
  });

  it("propagates an admission failure so Slack does not receive an acknowledgement", async () => {
    const host = ingress();
    host.admit.mockRejectedValueOnce(new Error("storage unavailable"));
    const body = "{}";
    await expect(handleSlackEvents(request(body, signed(body)), host)).rejects.toThrow("storage unavailable");
  });
});

describe("Slack app setup route", () => {
  function setup(connection: Awaited<ReturnType<SlackSetupCapability["connection"]>>, requestUrl: string | null): SlackSetupCapability {
    return {
      connection: async () => connection,
      endpoints: () => ({ requestUrl, oauthRedirectUrl: requestUrl && "https://valet.test/callback", userScopes: ["search:read"] }),
    };
  }

  it("builds the manifest from host endpoints and clamps the app name", async () => {
    const res = await handleSlackApp(request("", {}, `https://valet.test/api/org/slack?name=${encodeURIComponent(` ${"V".repeat(40)} `)}`),
      setup({ teamName: "Acme", teamId: "T1", grantedScopes: ["assistant:write", "chat:write", "im:history"] }, "https://valet.test/hook"));
    const body = await res.json();
    expect(body).toMatchObject({
      ingress: "webhook", requestUrl: "https://valet.test/hook", connected: true, teamName: "Acme", teamId: "T1",
      missingScopes: [...SLACK_OPTIONAL_BOT_SCOPES],
      manifest: {
        display_information: { name: "V".repeat(35) },
        oauth_config: { redirect_urls: ["https://valet.test/callback"], scopes: { user: ["search:read"] } },
        settings: { socket_mode_enabled: false, event_subscriptions: { request_url: "https://valet.test/hook" } },
      },
    });
  });

  it("reports socket mode, no connection, and nothing missing for unrecorded scopes", async () => {
    const socket = await (await handleSlackApp(request("", {}, "https://valet.test/x"), setup(null, null))).json();
    expect(socket).toMatchObject({ ingress: "socket_mode", requestUrl: null, connected: false, missingScopes: [] });
    const legacy = await (await handleSlackApp(request("", {}, "https://valet.test/x"), setup({ teamId: "T1" }, null))).json();
    expect(legacy).toMatchObject({ connected: true, missingScopes: [] });
  });
});

describe("Slack route descriptors", () => {
  it("declare valid routes and refuse to run without host capabilities", async () => {
    expect(validatePluginHttpRoutes(slackHttpRoutes)).toEqual([]);
    for (const route of slackHttpRoutes) {
      const res = route.auth === "signature" ? undefined
        : route.auth === "public" ? await route.handle(request("{}"))
        : await route.handle(request("{}"), { userId: "u", orgId: "o" });
      expect(res?.status).toBe(501);
    }
  });
});
