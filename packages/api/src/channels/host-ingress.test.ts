import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import {
  VirtualSandboxProvider,
  orchestratorSessionId,
  type ChannelTransport,
  type InboundChannelEvent,
  type OutboundChannelMessage,
  type RawChannelUpdate,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { eventDropLog } from "../schema/index.js";
import { linkIdentity } from "./identity-links.js";
import { ChannelHost, publicUrlFromEnv } from "./host.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";

function inbound(overrides: Partial<InboundChannelEvent> = {}): InboundChannelEvent {
  return {
    dispatchId: `fake:${Math.floor(Math.random() * 1e9)}`,
    conversationKey: "fake:dm:99",
    sender: { externalId: "77", displayName: "Ada" },
    kind: "message",
    text: "hello",
    raw: {},
    ...overrides,
  };
}

// ─── publicUrlFromEnv ───────────────────────────────────────────────────

describe("publicUrlFromEnv", () => {
  it("prefers VALET_PUBLIC_URL", () => {
    expect(publicUrlFromEnv({ VALET_PUBLIC_URL: "https://valet.example.com" })).toBe("https://valet.example.com");
  });
  it("falls back to a public BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "https://valet.example.com" })).toBe("https://valet.example.com");
  });
  it("rejects localhost/http BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "http://localhost:8788" })).toBeUndefined();
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "https://valet.localdev" })).toBeUndefined();
  });
  it("rejects 127.0.0.1 BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "https://127.0.0.1:8788" })).toBeUndefined();
  });
  it("rejects an unparseable BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "not a url" })).toBeUndefined();
  });
  it("no vars → undefined (long-poll default)", () => {
    expect(publicUrlFromEnv({})).toBeUndefined();
  });
});

// ─── long-poll mode ─────────────────────────────────────────────────────

/** Transport whose `poll()` yields queued raw updates, then blocks until
 * `signal` aborts — mirrors what a real long-poll transport does while
 * waiting on the next network round trip. */
class PollingFakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  queue: RawChannelUpdate[];
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];

  constructor(queue: RawChannelUpdate[]) {
    this.queue = queue;
  }

  verifyWebhook(): null {
    return null;
  }
  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    return update as InboundChannelEvent;
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

  async *poll(signal: AbortSignal): AsyncIterable<RawChannelUpdate> {
    for (const update of this.queue) {
      yield update;
    }
    // Block until aborted, exactly like a real long-poll transport waiting
    // on its next network round trip.
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

async function waitFor(check: () => Promise<boolean>, attempts = 50, delayMs = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("waitFor: condition never became true");
}

describe("long-poll mode", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    testDb = await freshTestPgDb();
  });

  afterEach(async () => {
    await engineHost?.destroyAll();
    faux.unregister();
  });

  function buildHost(transport: PollingFakeTransport): ChannelHost {
    const { pgdb, appDb } = testDb;
    const engineStore = new PgSessionStore(pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    const eventStream = new PgEventStream(pgdb);
    const engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create: () => transport }],
    };
    engineHost = new EngineHost({
      engineStore,
      sandboxProvider,
      eventStream,
      engineCredentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
    });
    return new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [fakePlugin],
      resolveOrgId: async () => ORG_ID,
    });
  }

  async function saveCredential(): Promise<void> {
    const engineCredentials = new PgCredentialStore(testDb.pgdb, deriveSecretKey("test-key"));
    await engineCredentials.save({ type: "org", id: ORG_ID }, "fake", {
      type: "bot_token",
      accessToken: "fake-bot-token",
    });
  }

  it("start() consumes poll() updates through handleUpdate and stop() halts the loop", async () => {
    await saveCredential();
    const transport = new PollingFakeTransport([inbound({ dispatchId: "fake:1" })]);
    const host = buildHost(transport);

    await host.start();

    await waitFor(async () => {
      const drops = await testDb.appDb.select().from(eventDropLog);
      return drops.some((d) => d.reason === "unlinked_sender");
    });

    // stop() awaits the loop's exit — this resolving proves the poll loop
    // observed the abort and returned rather than hanging forever.
    await host.stop();
  });

  it("a second start() call is a no-op — does not re-create transports or spawn a duplicate poll loop", async () => {
    await saveCredential();
    const transport = new PollingFakeTransport([inbound({ dispatchId: "fake:1" })]);
    let createCalls = 0;
    const { pgdb, appDb } = testDb;
    const engineStore = new PgSessionStore(pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    const eventStream = new PgEventStream(pgdb);
    const engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [
        {
          channelType: "fake",
          create: () => {
            createCalls++;
            return transport;
          },
        },
      ],
    };
    engineHost = new EngineHost({
      engineStore,
      sandboxProvider,
      eventStream,
      engineCredentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
    });
    const host = new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [fakePlugin],
      resolveOrgId: async () => ORG_ID,
    });

    await host.start();
    await host.start(); // second call must be a no-op

    expect(createCalls).toBe(1);

    await host.stop();
  });

  it("poller resumes after restart without duplicate admission", async () => {
    await saveCredential();
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    const update = inbound({ dispatchId: "fake:42" });
    const transportA = new PollingFakeTransport([update]);
    const hostA = buildHost(transportA);
    await hostA.start();

    const sessionId = orchestratorSessionId({ type: "user", id: USER_ID });
    async function userEntryCount(): Promise<number> {
      const session = await engineHost.orchestratorSessionFor(
        { type: "user", id: USER_ID },
        { actorUserId: USER_ID, orgId: ORG_ID },
      );
      const threadId = session.thread("fake:99").id;
      const entries = await session.providers.store.getEntries(sessionId, threadId);
      return entries.filter((e) => e.type === "message" && e.role === "user").length;
    }

    await waitFor(async () => (await userEntryCount()) === 1);
    await hostA.stop();

    // A fresh ChannelHost (fresh in-memory dedup cache) over the SAME
    // stores sees the identical dispatchId again. The engine's own
    // dispatchId-keyed admission idempotency — not the host's in-memory
    // Set, which reset with the new instance — must still prevent a
    // duplicate queue item.
    const transportB = new PollingFakeTransport([{ ...update }]);
    const hostB = buildHost(transportB);
    await hostB.start();

    // Give the second poll loop a beat to (not) admit a duplicate.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await userEntryCount()).toBe(1);

    await hostB.stop();
  });
});

// ─── webhook mode ───────────────────────────────────────────────────────

/** Transport whose `verifyWebhook` checks an `x-webhook-secret` header
 * against the host-held secret and, on match, hands back the parsed raw
 * update from the request body. */
class WebhookFakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  registeredUrl?: string;
  registeredSecret?: string;
  verifyWebhookCalls = 0;

  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null {
    this.verifyWebhookCalls++;
    if (req.headers["x-webhook-secret"] !== secrets.webhookSecret) return null;
    const body = JSON.parse(Buffer.from(req.rawBody).toString("utf8")) as RawChannelUpdate;
    return [body];
  }
  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    return update as InboundChannelEvent;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    return { conversationKey, messageId: "1" };
  }
  async sendMedia(conversationKey: string) {
    return { conversationKey, messageId: "m" };
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "g" };
  }
  async updateGatePrompt() {}
  async registerWebhook(url: string, secretToken: string): Promise<void> {
    this.registeredUrl = url;
    this.registeredSecret = secretToken;
  }
}

describe("webhook mode", () => {
  let api: TestApi;
  let transport: WebhookFakeTransport;

  beforeEach(async () => {
    transport = new WebhookFakeTransport();
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create: () => transport }],
    };
    api = await bootTestApi({ plugins: [fakePlugin], channelPublicUrl: "https://valet.example.com" });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "fake", {
      type: "bot_token",
      accessToken: "fake-bot-token",
    });
    await api.providers.channelHost.start();
  });

  afterEach(async () => {
    await api.cleanup();
  });

  it("registers the webhook URL with the transport on start()", () => {
    expect(transport.registeredUrl).toBe("https://valet.example.com/api/channels/fake/webhook");
    expect(transport.registeredSecret).toBeTruthy();
  });

  it("verify-fail → 403 + verify_failed drop log; verify-pass → 200 + routed", async () => {
    const badRes = await fetch(`${api.baseUrl}/api/channels/fake/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "wrong" },
      body: JSON.stringify(inbound()),
    });
    expect(badRes.status).toBe(403);

    await waitFor(async () => {
      const drops = await api.providers.db.select().from(eventDropLog);
      return drops.some((d) => d.reason === "verify_failed");
    });

    const goodRes = await fetch(`${api.baseUrl}/api/channels/fake/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": transport.registeredSecret ?? "" },
      body: JSON.stringify(inbound()),
    });
    expect(goodRes.status).toBe(200);
    expect(await goodRes.json()).toEqual({ ok: true });

    // handleUpdate is fired-and-forget; the sender is unlinked, so routing
    // lands on the unlinked_sender drop-log path once the async work runs.
    await waitFor(async () => {
      const drops = await api.providers.db.select().from(eventDropLog);
      return drops.some((d) => d.reason === "unlinked_sender");
    });
  });

  it("unknown channel type → 404", async () => {
    const res = await fetch(`${api.baseUrl}/api/channels/nope/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("oversized body → 413, host never invoked", async () => {
    const oversized = "x".repeat(1_048_577);
    const res = await fetch(`${api.baseUrl}/api/channels/fake/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    expect(transport.verifyWebhookCalls).toBe(0);
  });

  it("two bad-secret posts in quick succession → both 403, exactly one verify_failed drop row", async () => {
    const post = () =>
      fetch(`${api.baseUrl}/api/channels/fake/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": "wrong" },
        body: JSON.stringify(inbound()),
      });

    const [resA, resB] = await Promise.all([post(), post()]);
    expect(resA.status).toBe(403);
    expect(resB.status).toBe(403);

    await waitFor(async () => {
      const drops = await api.providers.db.select().from(eventDropLog);
      return drops.some((d) => d.reason === "verify_failed");
    });

    const drops = await api.providers.db.select().from(eventDropLog);
    expect(drops.filter((d) => d.reason === "verify_failed")).toHaveLength(1);
  });
});
