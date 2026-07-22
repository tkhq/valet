/**
 * `/api/me/identity-links` — Telegram account linking route tests
 * (channel-link Phase 7, Task 9). Also proves the app.ts mount order: this
 * router is mounted BEFORE `/api/me` so the longer, more specific prefix
 * wins under Hono's route matching (see `app.ts`'s comment).
 */
import { afterEach, describe, expect, it } from "vitest";
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
  await api?.cleanup();
  api = undefined;
});

class FakeTelegramTransport implements ChannelTransport {
  readonly channelType: string = "telegram";
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
  };
  return { plugin, transport };
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

describe("GET /api/me/identity-links", () => {
  it("reports linked:false, channelReady:false when the transport plugin is present but not running", async () => {
    // The provider list derives from transport-declaring plugins (slack pass);
    // an app booted with zero transport plugins reports zero links.
    const { plugin } = telegramPlugin();
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/me/identity-links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListIdentityLinksResponse;
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ provider: "telegram", linked: false, channelReady: false });
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

describe("POST /api/me/identity-links/telegram/start", () => {
  it("409s when the transport isn't running", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "telegram bot not configured" });
  });

  it("200s with a deep link when the transport is running; consuming the code links the caller", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StartIdentityLinkResponse;
    expect(body.expiresInSeconds).toBe(600);
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/valet_test_bot\?start=[A-Za-z0-9_-]{20,}$/);

    expect(body.delivery).toBe("deep_link");
    if (!body.deepLink) throw new Error("expected deepLink on delivery=deep_link");
    const code = body.deepLink.split("start=")[1] as string;
    const consumed = await consumeLinkCode(api.providers.db, "telegram", code);
    expect(consumed).toMatchObject({ userId: "local-user" });

    // The code is single-use — consuming it again fails.
    const consumedAgain = await consumeLinkCode(api.providers.db, "telegram", code);
    expect(consumedAgain).toBeNull();
  });
});

describe("PATCH /api/me/identity-links/telegram", () => {
  it("404s before any link exists", async () => {
    api = await bootWithRunningTelegram();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyAttention: false }),
    });
    expect(res.status).toBe(404);
  });

  it("200s and flips notifyAttention after linking", async () => {
    api = await bootWithRunningTelegram();

    const start = await fetch(`${api.baseUrl}/api/me/identity-links/telegram/start`, { method: "POST" });
    const { deepLink } = (await start.json()) as StartIdentityLinkResponse;
    if (!deepLink) throw new Error("expected deepLink on delivery=deep_link");
    const code = deepLink.split("start=")[1] as string;
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
});

describe("DELETE /api/me/identity-links/telegram", () => {
  it("200s and GET reflects linked:false afterward", async () => {
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
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me/identity-links/telegram`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

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

class FakeSlackTransport extends FakeTelegramTransport {
  // channelType is readonly on the base — shadow via declaration.
  override readonly channelType: string = "slack";
  async openDirectConversation(externalId: string): Promise<string> {
    return `slack:T1:D-${externalId}`;
  }
  async listWorkspaceMembers(query: string): Promise<Array<{ id: string; name: string; realName?: string }>> {
    const all = [
      { id: "U100", name: "conner", realName: "Conner Swann" },
      { id: "U200", name: "sam", realName: "Sam Doe" },
    ];
    return all.filter((m) => m.name.includes(query));
  }
}

async function bootWithRunningSlack(): Promise<{ api: TestApi; transport: FakeSlackTransport }> {
  const transport = new FakeSlackTransport();
  const plugin: ValetPlugin = {
    name: "slack",
    version: "0",
    transports: [{ channelType: "slack", ingress: "external-webhook", create: () => transport }],
  };
  const booted = await bootTestApi({ plugins: [plugin] });
  await booted.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
    type: "bot_token",
    accessToken: "xoxb-test",
    metadata: { webhookSecret: "s", teamId: "T1" },
  });
  await booted.providers.channelHost.start();
  return { api: booted, transport };
}

describe("slack identity linking (DM-code flow)", () => {
  it("409s the typeahead and start when the slack transport isn't running", async () => {
    api = await bootTestApi();
    expect((await fetch(`${api.baseUrl}/api/me/identity-links/slack/users?q=co`)).status).toBe(409);
    const start = await fetch(`${api.baseUrl}/api/me/identity-links/slack/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U100" }),
    });
    expect(start.status).toBe(409);
  });

  it("typeahead → start DMs a code to the chosen member → verify links the caller", async () => {
    const booted = await bootWithRunningSlack();
    api = booted.api;

    const users = await fetch(`${api.baseUrl}/api/me/identity-links/slack/users?q=co`);
    expect(users.status).toBe(200);
    const { members } = (await users.json()) as { members: Array<{ id: string; name: string }> };
    expect(members).toEqual([{ id: "U100", name: "conner", realName: "Conner Swann" }]);

    const start = await fetch(`${api.baseUrl}/api/me/identity-links/slack/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U100" }),
    });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as StartIdentityLinkResponse;
    expect(startBody.delivery).toBe("dm_code");
    expect(startBody.deepLink).toBeUndefined();

    // The code went out via the transport DM, addressed to the IM channel.
    expect(booted.transport.sent).toHaveLength(1);
    expect(booted.transport.sent[0].conversationKey).toBe("slack:T1:D-U100");
    const match = booted.transport.sent[0].message.markdown.match(/\*\*([A-Za-z0-9_-]{20,})\*\*/);
    if (!match) throw new Error("expected the DM to carry the link code");
    const code = match[1];

    const verify = await fetch(`${api.baseUrl}/api/me/identity-links/slack/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);

    const links = (await (await fetch(`${api.baseUrl}/api/me/identity-links`)).json()) as ListIdentityLinksResponse;
    const slack = links.links.find((l: IdentityLinkStatus) => l.provider === "slack");
    expect(slack).toMatchObject({ linked: true, externalId: "U100", channelReady: true });
  });

  it("400s an invalid or reused verify code", async () => {
    const booted = await bootWithRunningSlack();
    api = booted.api;

    const bad = await fetch(`${api.baseUrl}/api/me/identity-links/slack/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "nope" }),
    });
    expect(bad.status).toBe(400);

    await fetch(`${api.baseUrl}/api/me/identity-links/slack/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "U100" }),
    });
    const match = booted.transport.sent[0].message.markdown.match(/\*\*([A-Za-z0-9_-]{20,})\*\*/);
    const code = match ? match[1] : "";
    expect((await fetch(`${api.baseUrl}/api/me/identity-links/slack/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })).status).toBe(200);
    // Single-use.
    expect((await fetch(`${api.baseUrl}/api/me/identity-links/slack/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })).status).toBe(400);
  });
});
