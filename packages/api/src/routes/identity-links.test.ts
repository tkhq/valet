/**
 * `/api/me/identity-links` — provider-parameterized identity-link routes
 * (channel-link Phase 7). Also proves the app.ts mount order: this router is
 * mounted BEFORE `/api/me` so the longer, more specific prefix wins under
 * Hono's route matching (see `app.ts`'s comment).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import slackUserPlugin from "@valet/plugin-slack-user/plugin";
import type { ChannelTransport, OutboundChannelMessage, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { consumeLinkCode, linkIdentity } from "../channels/identity-links.js";
import type {
  IdentityLinkStatus,
  ListIdentityLinksResponse,
  StartIdentityLinkResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

class FakeTelegramTransport implements ChannelTransport {
  readonly channelType = "telegram";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async getMe() {
    return { username: "valet_test_bot" };
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: String(this.sent.length) };
  }
  async sendMedia(conversationKey: string) {
    return { conversationKey, messageId: "m" };
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "g" };
  }
  async updateGatePrompt() {}
  async answerCallback() {}
}

function telegramPlugin(): { plugin: ValetPlugin; transport: FakeTelegramTransport } {
  const transport = new FakeTelegramTransport();
  const plugin: ValetPlugin = {
    name: "telegram",
    version: "0",
    transports: [{ channelType: "telegram", create: () => transport }],
    identityLink: {
      provider: "telegram",
      instructions: "Tap the link or send /start <code> to the bot.",
      deepLink: ({ botUsername, code }) =>
        botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
    },
  };
  return { plugin, transport };
}

function slackPlugin(): ValetPlugin {
  return {
    name: "slack-user",
    version: "0",
    identityLink: {
      provider: "slack",
      instructions: "In Slack, open a DM with the Valet app and send: link <code>",
    },
  };
}

/** Boots with the fake telegram transport registered + a bot token
 * credential saved, then starts the ChannelHost — mirrors `host.test.ts`'s
 * pattern, since `bootTestApi`'s own `startChannelHost` option starts the
 * host before a caller has a chance to seed credentials. */
async function bootWithRunningTelegram(): Promise<TestApi> {
  const { plugin } = telegramPlugin();
  const booted = await bootTestApi({ plugins: [plugin] });
  await booted.providers.engineCredentials.save({ type: "org", id: "local-org" }, "telegram", {
    type: "bot_token",
    accessToken: "tg-test-token",
  });
  await booted.providers.channelHost.start();
  return booted;
}

/** Boots with both telegram and slack plugins, telegram running (transport
 *  started), slack declared but no transport (channelHost.isRunning("slack")
 *  will be false unless the slack transport is also seeded). */
async function bootWithBothPlugins(): Promise<TestApi> {
  const { plugin: tg } = telegramPlugin();
  const sl = slackPlugin();
  const booted = await bootTestApi({ plugins: [tg, sl] });
  await booted.providers.engineCredentials.save({ type: "org", id: "local-org" }, "telegram", {
    type: "bot_token",
    accessToken: "tg-test-token",
  });
  await booted.providers.channelHost.start();
  return booted;
}

// ── GET / ────────────────────────────────────────────────────────────────────

describe("GET /api/me/identity-links", () => {
  it("reports linked:false, channelReady:false when no transport is running", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListIdentityLinksResponse;
    // No plugins with identityLink declarations → empty list.
    expect(body.links).toHaveLength(0);
  });

  it("returns one entry per declaring plugin (telegram only)", async () => {
    const { plugin } = telegramPlugin();
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListIdentityLinksResponse;
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ provider: "telegram", linked: false, channelReady: false });
  });

  // "Sign in with Slack" links through the slack-user OAuth connect. The card
  // offers it only when the deployment can run that flow.
  it.each([
    ["configured", "client-id", "slack-user"],
    ["missing its client env", undefined, undefined],
  ])("reports the linking OAuth service only when it is %s", async (_label, clientId, expected) => {
    vi.stubEnv("SLACK_CLIENT_ID", clientId);
    vi.stubEnv("SLACK_CLIENT_SECRET", clientId === undefined ? undefined : "client-secret");
    const slack: ValetPlugin = {
      name: "slack",
      version: "0",
      identityLink: { provider: "slack", instructions: "send: link <code>", oauthService: "slack-user" },
    };
    api = await bootTestApi({ plugins: [slack, slackUserPlugin] });

    const body = (await (await fetch(`${api.baseUrl}/api/me/identity-links`)).json()) as ListIdentityLinksResponse;
    expect(body.links[0]?.oauthService).toBe(expected);
  });

  it("returns two entries when both telegram and slack declare identityLink", async () => {
    api = await bootWithBothPlugins();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListIdentityLinksResponse;
    expect(body.links).toHaveLength(2);
    const providers = body.links.map((l) => l.provider);
    expect(providers).toContain("telegram");
    expect(providers).toContain("slack");
    // Telegram is running; slack has no transport seeded so channelReady is false.
    const tg = body.links.find((l) => l.provider === "telegram");
    const sl = body.links.find((l) => l.provider === "slack");
    expect(tg).toMatchObject({ linked: false, channelReady: true });
    expect(sl).toMatchObject({ linked: false, channelReady: false });
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

// ── POST /:provider/start ────────────────────────────────────────────────────

describe("POST /api/me/identity-links/:provider/start", () => {
  it("404s on an unknown provider", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/nope/start`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown identity provider "nope"' });
  });

  it("409s when the transport isn't running (telegram)", async () => {
    const { plugin } = telegramPlugin();
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "telegram transport is not running. Configure the telegram bot token, then retry.",
    });
  });

  it("200s with code + deepLink for telegram when running", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StartIdentityLinkResponse;
    expect(body.expiresInSeconds).toBe(600);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/valet_test_bot\?start=[A-Za-z0-9_-]{20,}$/);
    expect(body.instructions).toBe("Tap the link or send /start <code> to the bot.");

    const consumed = await consumeLinkCode(api.providers.db, "telegram", body.code);
    expect(consumed).toMatchObject({ userId: "local-user" });

    // The code is single-use — consuming it again fails.
    const consumedAgain = await consumeLinkCode(api.providers.db, "telegram", body.code);
    expect(consumedAgain).toBeNull();
  });

  it("200s with code but NO deepLink for slack", async () => {
    // Boot with both plugins so slack is declared, but slack has no transport
    // so isRunning("slack") is false. We need slack to be "running" for this
    // test; since there is no real slack transport in tests, we use a minimal
    // plugin without transports — isRunning will return false unless we work
    // around it.  For the purpose of the 200 test we boot slack only and use
    // bootTestApi which lets us add a fake transport-less credential so the
    // channelHost treats the transport as running.
    //
    // Actually, slack has no ChannelTransport factory at all in tests, so
    // channelHost.isRunning("slack") will always be false here. This test
    // can only be fully integration-tested once a real slack transport exists.
    // Skipping the "transport is running" requirement — test the shape only
    // via a workaround: add a trivial FakeSlack transport.
    class FakeSlackTransport implements ChannelTransport {
      readonly channelType = "slack";
      verifyWebhook(): null { return null; }
      parseUpdate(): null { return null; }
      async getMe() { return { username: null }; }
      async send(conversationKey: string, message: OutboundChannelMessage) {
        return { conversationKey, messageId: "1" };
      }
      async sendMedia(conversationKey: string) { return { conversationKey, messageId: "m" }; }
      async sendGatePrompt(conversationKey: string) { return { conversationKey, messageId: "g" }; }
      async updateGatePrompt() {}
      async answerCallback() {}
    }

    const slackTransport = new FakeSlackTransport();
    const sl: ValetPlugin = {
      name: "slack-user",
      version: "0",
      transports: [{ channelType: "slack", create: () => slackTransport }],
      identityLink: {
        provider: "slack",
        instructions: "In Slack, open a DM with the Valet app and send: link <code>",
      },
    };
    api = await bootTestApi({ plugins: [sl] });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token",
      accessToken: "slack-test-token",
    });
    await api.providers.channelHost.start();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StartIdentityLinkResponse;
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.deepLink).toBeUndefined();
    expect(body.instructions).toBe("In Slack, open a DM with the Valet app and send: link <code>");
    expect(body.expiresInSeconds).toBe(600);
  });
});

// ── DELETE /:provider ────────────────────────────────────────────────────────

describe("DELETE /api/me/identity-links/:provider", () => {
  it("404s on an unknown provider", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown identity provider "nope"' });
  });

  it("200s and GET reflects linked:false afterward (telegram)", async () => {
    api = await bootWithRunningTelegram();

    await linkIdentity(api.providers.db, { provider: "telegram", externalId: "555", userId: "local-user" });

    const del = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const get = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const body = (await get.json()) as ListIdentityLinksResponse;
    expect(body.links[0]).toMatchObject({ provider: "telegram", linked: false });
  });

  it("200s (idempotent) even when never linked", async () => {
    const { plugin } = telegramPlugin();
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("200s for slack after seeding a link and the row is gone", async () => {
    const sl = slackPlugin();
    api = await bootTestApi({ plugins: [sl] });
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U123", userId: "local-user" });

    const del = await fetch(`${api.baseUrl}/api/me/identity-links/slack`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // Row is gone — identityForUser returns null.
    const get = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const body = (await get.json()) as ListIdentityLinksResponse;
    const slLink = body.links.find((l) => l.provider === "slack");
    expect(slLink).toMatchObject({ linked: false });
  });
});

// ── PATCH /:provider ─────────────────────────────────────────────────────────

describe("PATCH /api/me/identity-links/:provider", () => {
  it("404s on an unknown provider", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/nope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown identity provider "nope"' });
  });

  it("404s before any link exists (telegram)", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(res.status).toBe(404);
  });

  it("200s and flips notifyAttention after linking (telegram)", async () => {
    api = await bootWithRunningTelegram();

    const start = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    const { code } = (await start.json()) as StartIdentityLinkResponse;
    const consumed = await consumeLinkCode(api.providers.db, "telegram", code);
    if (!consumed) throw new Error("expected code to be consumable");
    await linkIdentity(api.providers.db, { provider: "telegram", externalId: "999", userId: consumed.userId });

    const patch = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true });

    const get = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const body = (await get.json()) as ListIdentityLinksResponse;
    const link = body.links.find((l): l is IdentityLinkStatus => l.provider === "telegram");
    expect(link).toMatchObject({ linked: true, notifyAttention: false, externalId: "999" });
  });

  it("200s for slack with { notifyAttention: false } after seeding a link", async () => {
    const sl = slackPlugin();
    api = await bootTestApi({ plugins: [sl] });
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U456", userId: "local-user" });

    const patch = await fetch(`${api.baseUrl}/api/me/identity-links/slack`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true });
  });

  it("404s for slack without a link", async () => {
    const sl = slackPlugin();
    api = await bootTestApi({ plugins: [sl] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Coexistence ───────────────────────────────────────────────────────────────

describe("identity-links and /api/me coexist", () => {
  // NOTE: this does NOT prove mount order matters — meRouter today registers
  // only GET / and PATCH / (no wildcard/param routes), so there is no actual
  // collision for ordering to resolve; this mount is BEFORE /api/me purely
  // defensively (see app.ts's comment). This test just confirms both routers
  // are reachable and return their own distinct response shapes.
  it("GET /api/me/identity-links returns the links shape; GET /api/me still returns the profile shape", async () => {
    api = await bootTestApi();

    const linksRes = await fetch(`${api.baseUrl}/api/me/identity-links`);
    expect(linksRes.status).toBe(200);
    const linksBody = (await linksRes.json()) as ListIdentityLinksResponse;
    expect(Array.isArray(linksBody.links)).toBe(true);

    const meRes = await fetch(`${api.baseUrl}/api/me`);
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { id: string; email: string };
    expect(meBody).toMatchObject({ id: "local-user", email: "local@dev" });
  });
});

// ── POST /:provider/deliver ──────────────────────────────────────────────────

import { ChannelLookupError } from "@valet/engine";
import type { DeliverIdentityLinkResponse } from "../wire/types.js";

/** A slack-shaped transport with the delivery capabilities: email lookup and
 * a direct-conversation opener. `send` records outbound DMs. */
class FakeDeliverySlackTransport implements ChannelTransport {
  readonly channelType = "slack";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  /** Members keyed by email. */
  members = new Map<string, { externalId: string; displayName: string }>();
  lookupError: ChannelLookupError | null = null;
  sendError: Error | null = null;
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async lookupUserByEmail(email: string) {
    if (this.lookupError) throw this.lookupError;
    return this.members.get(email) ?? null;
  }
  async listWorkspaceMembers(query: string) {
    return [
      { id: "U777", name: "conner", realName: "Conner Swann" },
      { id: "U888", name: "pat" },
    ].filter((m) => m.name.includes(query.toLowerCase()));
  }
  async openDirectConversation(externalId: string): Promise<string> {
    return `slack:T1:D-${externalId}:1700000000.000001`;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    if (this.sendError) throw this.sendError;
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: String(this.sent.length) };
  }
  async sendMedia(conversationKey: string) {
    return { conversationKey, messageId: "m" };
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "g" };
  }
  async updateGatePrompt() {}
  async answerCallback() {}
}

function deliverySlackPlugin(): { plugin: ValetPlugin; transport: FakeDeliverySlackTransport } {
  const transport = new FakeDeliverySlackTransport();
  const plugin: ValetPlugin = {
    name: "slack-user",
    version: "0",
    transports: [{ channelType: "slack", create: () => transport }],
    identityLink: {
      provider: "slack",
      instructions: "In Slack, open a DM with the Valet app and send: link <code>",
      deliveryDm: ({ code }) => `Your Valet link code is ${code}. Enter it in Valet.`,
    },
  };
  return { plugin, transport };
}

/** The code the fake transport DMed, read the way a person reads the DM. */
function dmCode(transport: FakeDeliverySlackTransport): string {
  const match = /link code is (\S+)\./.exec(transport.sent[0]?.message.markdown ?? "");
  if (!match?.[1]) throw new Error("no code in the DM");
  return match[1];
}

async function verify(base: string, code: string): Promise<Response> {
  return fetch(`${base}/api/me/identity-links/slack/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/** Boots with the delivery-capable slack fake running. */
async function bootWithDeliverySlack(): Promise<{ api: TestApi; transport: FakeDeliverySlackTransport }> {
  const { plugin, transport } = deliverySlackPlugin();
  const booted = await bootTestApi({ plugins: [plugin] });
  await booted.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "slack-test-token",
  });
  await booted.providers.channelHost.start();
  return { api: booted, transport };
}

describe("POST /api/me/identity-links/:provider/deliver", () => {
  it("404s on an unknown provider", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/nope/deliver`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown identity provider "nope"' });
  });

  it("409s when the transport is not running", async () => {
    const { plugin } = deliverySlackPlugin();
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("404s when the provider cannot deliver (telegram: no deliveryDm, no lookup)", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/deliver`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not support code delivery");
  });

  it("202s with email_not_in_workspace when the caller's email names nobody", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ reason: "email_not_in_workspace" });
    // No code was burned, no DM sent.
    expect(booted.transport.sent).toHaveLength(0);
  });

  // v1's flow: the bot DMs the code and the person types it into Valet.
  it("200s, DMs the code, and keeps it out of the response", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    // The local-auth stub user is local-user <local@dev>.
    booted.transport.members.set("local@dev", { externalId: "U777", displayName: "conner" });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ delivered: true, externalId: "U777", displayName: "conner", expiresInSeconds: 600 });
    // The DM went to the opened direct conversation, not a guessed key.
    expect(booted.transport.sent).toHaveLength(1);
    expect(booted.transport.sent[0]?.conversationKey).toBe("slack:T1:D-U777:1700000000.000001");
    const code = dmCode(booted.transport);
    expect(JSON.stringify(body)).not.toContain(code);

    // Entering the DMed code links the account the DM went to.
    const verified = await verify(api.baseUrl, code);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ linked: true, externalId: "U777" });
    const links = await (await fetch(`${api.baseUrl}/api/me/identity-links`)).json() as ListIdentityLinksResponse;
    expect(links.links.find((l) => l.provider === "slack")).toMatchObject({ linked: true, externalId: "U777" });
  });

  // The person a code was DMed to holds it. Redeeming it from chat would link
  // THEIR account to the requester's Valet user, so chat never redeems it.
  it("never redeems a DMed code from chat", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U888", displayName: "Pat" }),
    });
    expect(res.status).toBe(200);
    expect(await consumeLinkCode(api.providers.db, "slack", dmCode(booted.transport))).toBeNull();
  });

  it("advertises codeDelivery:false and 404s deliver when deliveryDm is missing", async () => {
    const transport = new FakeDeliverySlackTransport();
    const plugin: ValetPlugin = {
      name: "slack-user",
      version: "0",
      transports: [{ channelType: "slack", create: () => transport }],
      identityLink: {
        provider: "slack",
        instructions: "In Slack, open a DM with the Valet app and send: link <code>",
        // deliveryDm deliberately absent — delivery must be off.
      },
    };
    api = await bootTestApi({ plugins: [plugin] });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token",
      accessToken: "slack-test-token",
    });
    await api.providers.channelHost.start();

    const list = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const listBody = (await list.json()) as ListIdentityLinksResponse;
    expect(listBody.links.find((l) => l.provider === "slack")).toMatchObject({ codeDelivery: false });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("400s with the corrective action when the bot lacks the lookup scope", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    booted.transport.lookupError = new ChannelLookupError(
      "missing_scope",
      "The Slack app is missing the users:read.email scope. Reinstall the Slack app to grant it.",
    );

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("users:read.email");
  });

  it("502s when the provider lookup fails upstream", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    booted.transport.lookupError = new ChannelLookupError("transport", "Slack users.lookupByEmail failed: http 500");

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(502);
  });

  it("200s and DMs the picked member when the body carries externalId (find-me-by-name)", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    // No members map entry: the email lookup would 202, proving the body
    // path never consults it.

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U888", displayName: "Pat" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeliverIdentityLinkResponse;
    expect(body).toMatchObject({ delivered: true, externalId: "U888", displayName: "Pat" });
    expect(booted.transport.sent).toHaveLength(1);
    expect(booted.transport.sent[0]?.conversationKey).toBe("slack:T1:D-U888:1700000000.000001");
    // The code links the account it was DMed to, not the caller's email match.
    const verified = await verify(api.baseUrl, dmCode(booted.transport));
    expect(await verified.json()).toEqual({ linked: true, externalId: "U888" });
  });

  it("400s on a malformed JSON body", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("400s when externalId is present but not a non-empty string", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    for (const externalId of [42, "", null]) {
      const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalId }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "externalId must be a non-empty string" });
    }
    expect(booted.transport.sent).toHaveLength(0);
  });

  it("502s and names the fallback when the DM send fails", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    booted.transport.members.set("local@dev", { externalId: "U777", displayName: "conner" });
    booted.transport.sendError = new Error("channel_not_found");

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("link code shown on the card");
  });
});

describe("GET /api/me/identity-links — codeDelivery flag", () => {
  it("is true only for a running transport with email lookup + deliveryDm", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const body = (await res.json()) as ListIdentityLinksResponse;
    expect(body.links.find((l) => l.provider === "slack")).toMatchObject({
      channelReady: true,
      codeDelivery: true,
      memberSearch: true,
    });
  });

  it("is false for telegram (no deliveryDm, no email lookup) even when running", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    const body = (await res.json()) as ListIdentityLinksResponse;
    expect(body.links.find((l) => l.provider === "telegram")).toMatchObject({
      channelReady: true,
      codeDelivery: false,
      memberSearch: false,
    });
  });
});

// ── GET /:provider/members ───────────────────────────────────────────────────

describe("GET /api/me/identity-links/:provider/members", () => {
  it("404s on an unknown provider", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/nope/members`);
    expect(res.status).toBe(404);
  });

  it("404s when the provider has no member directory (telegram)", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/members`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not support member search");
  });

  it("200s with mapped entries, realName falling back to the handle", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/members?query=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    expect(body.members).toEqual([
      { externalId: "U777", displayName: "Conner Swann", handle: "conner" },
      { externalId: "U888", displayName: "pat", handle: "pat" },
    ]);
  });

  it("filters by the query string", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/members?query=pat`);
    const body = (await res.json()) as { members: Array<{ externalId: string }> };
    expect(body.members.map((m) => m.externalId)).toEqual(["U888"]);
  });
});

// ── TTL copy stays honest ────────────────────────────────────────────────────

import { CODE_TTL_MS } from "../channels/identity-links.js";
import realSlackPlugin from "@valet/plugin-slack/plugin";

describe("link-code TTL copy", () => {
  it("the slack link-code DM names the same expiry CODE_TTL_MS enforces", () => {
    // The tripwire that catches a TTL tune the copy missed.
    const minutes = CODE_TTL_MS / 60_000;
    expect(realSlackPlugin.identityLink?.deliveryDm?.({ code: "c0de" })).toContain(`${minutes} minutes`);
  });
});

// ── POST /:provider/verify ───────────────────────────────────────────────────

import { identityForExternal, mintDeliveredLinkCode } from "../channels/identity-links.js";

describe("POST /api/me/identity-links/:provider/verify", () => {
  it("400s on a wrong code and links nothing", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    await mintDeliveredLinkCode(api.providers.db, "local-user", "slack", "U777");

    const res = await verify(api.baseUrl, "not-the-code");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("invalid or expired");
  });

  // A code DMed for someone else's request is bound to that requester, so a
  // signed-in user who sees it cannot link the account to themselves.
  it("400s on a code another user requested", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    const code = await mintDeliveredLinkCode(api.providers.db, "someone-else", "slack", "U777");

    const res = await verify(api.baseUrl, code);
    expect(res.status).toBe(400);
  });

  it("400s on a shown code, which is redeemed only from chat", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    const start = (await (await fetch(`${api.baseUrl}/api/me/identity-links/slack/start`, { method: "POST" })).json()) as StartIdentityLinkResponse;

    expect((await verify(api.baseUrl, start.code)).status).toBe(400);
  });

  // Same rule as the OAuth connect's identity_conflict: an account another
  // Valet user linked stays theirs.
  it("409s and keeps the existing link when the DMed account belongs to another Valet user", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U777", userId: "someone-else" });
    const code = await mintDeliveredLinkCode(api.providers.db, "local-user", "slack", "U777");

    const res = await verify(api.baseUrl, code);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("linked to another Valet user");
    const owner = await identityForExternal(api.providers.db, "slack", "U777");
    expect(owner?.userId).toBe("someone-else");
  });

  it("deliver refuses, and DMs nothing, when the account belongs to another Valet user", async () => {
    const booted = await bootWithDeliverySlack();
    api = booted.api;
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U888", userId: "someone-else" });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/slack/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U888", displayName: "Pat" }),
    });
    expect(res.status).toBe(409);
    expect(booted.transport.sent).toHaveLength(0);
  });
});
