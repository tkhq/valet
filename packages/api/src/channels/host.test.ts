import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import {
  VirtualSandboxProvider,
  orchestratorSessionId,
  type ChannelTransport,
  type InboundChannelEvent,
  type OutboundChannelMessage,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { eventDropLog, userIdentityLinks } from "../schema/index.js";
import { linkIdentity, mintLinkCode } from "./identity-links.js";
import { ChannelHost } from "./host.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";

class FakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  answered: Array<{ callbackId: string; text?: string }> = [];
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
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
  async answerCallback(callbackId: string, text?: string) {
    this.answered.push({ callbackId, text });
  }
}

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

describe("ChannelHost.handleUpdate", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let host: ChannelHost;
  let fakeTransport: FakeTransport;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    // Hijack the real anthropic-messages api so EngineHost's own model
    // resolution (which always calls pi-ai's static getModel("anthropic",
    // defaultModelId)) resolves to the REAL claude-haiku-4-5 Model object,
    // but its stream calls are intercepted by this faux provider — no
    // ANTHROPIC_API_KEY / network needed. See happy-path.test.ts for the
    // unmodified (non-EngineHost) faux usage this mirrors.
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    // The host resolver now throws NoCredentialsError pre-run when no key
    // exists anywhere (vitest.setup.ts scrubs the real env); the faux stream
    // ignores the key's value, it just has to exist for the turn to start.
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");

    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;

    const engineStore = new PgSessionStore(pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    const eventStream = new PgEventStream(pgdb);
    const engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));

    fakeTransport = new FakeTransport();
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create: () => fakeTransport }],
    };

    await engineCredentials.save({ type: "org", id: ORG_ID }, "fake", {
      type: "bot_token",
      accessToken: "fake-bot-token",
    });

    engineHost = new EngineHost({
      engineStore,
      sandboxProvider,
      eventStream,
      engineCredentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
    });

    host = new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [fakePlugin],
      resolveOrgId: async () => ORG_ID,
    });
    await host.start();
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  it("unlinked sender: drop log row + one rate-limited reply", async () => {
    await host.handleUpdate("fake", inbound());
    await host.handleUpdate("fake", inbound({ text: "again" }));
    const drops = await testDb.appDb.select().from(eventDropLog);
    expect(drops.filter((d) => d.reason === "unlinked_sender")).toHaveLength(2);
    expect(fakeTransport.sent).toHaveLength(1); // second reply suppressed within the hour
  });

  it("/start with a valid code links the account and confirms", async () => {
    const code = await mintLinkCode(testDb.appDb, USER_ID, "fake");
    await host.handleUpdate("fake", inbound({ kind: "command", command: { name: "start", args: code } }));
    const links = await testDb.appDb.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "fake"));
    expect(links[0]).toMatchObject({ externalId: "77", userId: USER_ID });
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Linked");
  });

  it("/start with a bad code replies invalid and does not link", async () => {
    await host.handleUpdate("fake", inbound({ kind: "command", command: { name: "start", args: "bad" } }));
    expect(fakeTransport.sent[0]?.message.markdown).toMatch(/invalid or expired/i);
    const links = await testDb.appDb.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "fake"));
    expect(links).toHaveLength(0);
  });

  it("linked message is admitted on the orchestrator thread telegram-style key with dispatch dedup", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    const ev = inbound({ dispatchId: "fake:1" });
    await host.handleUpdate("fake", ev);
    await host.handleUpdate("fake", { ...ev }); // duplicate dispatchId

    const sessionId = orchestratorSessionId({ type: "user", id: USER_ID });
    const session = await engineHost.orchestratorSessionFor(
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const threadId = session.thread("fake:99").id;
    // The user entry is persisted asynchronously as the turn is claimed
    // (Thread.claimNext's fencedWrite, after submitPrompt's admission
    // returns) — poll briefly instead of asserting immediately.
    let userEntries: Awaited<ReturnType<typeof session.providers.store.getEntries>> = [];
    for (let i = 0; i < 50; i++) {
      const entries = await session.providers.store.getEntries(sessionId, threadId);
      userEntries = entries.filter((e) => e.type === "message" && e.role === "user");
      if (userEntries.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(userEntries).toHaveLength(1);

    const drops = await testDb.appDb.select().from(eventDropLog);
    expect(drops.some((d) => d.reason === "duplicate")).toBe(true);
  });

  it("gate_callback with unknown ref answers 'expired' and drop-logs", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await host.handleUpdate(
      "fake",
      inbound({
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId: "cb9", ref: { conversationKey: "fake:dm:99", messageId: "41" } },
      }),
    );
    expect(fakeTransport.answered[0]).toMatchObject({ callbackId: "cb9" });
    const drops = await testDb.appDb.select().from(eventDropLog);
    expect(drops.some((d) => d.reason === "unsupported_kind" && d.detail.includes("unknown_gate_ref"))).toBe(true);
  });
});
