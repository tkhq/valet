import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import {
  VirtualSandboxProvider,
  type ChannelTransport,
  type FetchedChannelMedia,
  type InboundChannelMedia,
  type InboundChannelEvent,
  type OutboundChannelMessage,
  type SignalContent,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { eventDropLog, userIdentityLinks, users } from "../schema/index.js";
import { linkIdentity, mintLinkCode } from "./identity-links.js";
import { ChannelHost } from "./host.js";
import { deliverToAssistantThread } from "../events/assistant-delivery.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";

class FakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  answered: Array<{ callbackId: string; text?: string }> = [];
  fetchedMedia: FetchedChannelMedia | null = null;
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
  async fetchMedia(_media: InboundChannelMedia): Promise<FetchedChannelMedia | null> {
    return this.fetchedMedia;
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "g" };
  }
  async updateGatePrompt() {}
  async answerCallback(callbackId: string, text?: string) {
    this.answered.push({ callbackId, text });
  }
}

/**
 * A transport whose conversationKey holds more than the thread key does, the
 * way Slack's holds the workspace id. It owns both directions of the mapping
 * and refuses a key from another workspace, so a host that skips the hooks
 * fails here instead of posting somewhere plausible.
 */
class KeyedTransport implements ChannelTransport {
  readonly channelType = "keyed";
  readonly realm = "R1";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  opened: string[] = [];
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  threadKeyFromConversationKey(conversationKey: string): string {
    return `keyed:${conversationKey.split(":")[2] ?? ""}`;
  }
  conversationKeyFromThreadKey(threadKey: string): string | null {
    const id = threadKey.slice("keyed:".length);
    if (!threadKey.startsWith("keyed:") || id === "" || id.includes(":")) return null;
    return `keyed:${this.realm}:${id}`;
  }
  async openDirectConversation(externalId: string): Promise<string> {
    this.opened.push(externalId);
    return `keyed:${this.realm}:D-${externalId}`;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    if (!conversationKey.startsWith(`keyed:${this.realm}:`)) {
      throw new Error(`refusing a key this transport did not mint: "${conversationKey}"`);
    }
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
  let keyedTransport: KeyedTransport;
  let faux: FauxProviderRegistration;
  let engineStore: PgSessionStore;
  let eventStream: PgEventStream;
  let engineCredentials: PgCredentialStore;

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

    engineStore = new PgSessionStore(pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    eventStream = new PgEventStream(pgdb);
    engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));

    fakeTransport = new FakeTransport();
    keyedTransport = new KeyedTransport();
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [
        { channelType: "fake", create: () => fakeTransport },
        { channelType: "keyed", create: () => keyedTransport },
      ],
    };

    for (const service of ["fake", "keyed"]) {
      await engineCredentials.save({ type: "org", id: ORG_ID }, service, {
        type: "bot_token",
        accessToken: "fake-bot-token",
      });
    }

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

  it("stop() completing while start() awaits a probe prevents ingress/outbound from starting", async () => {
    // start() now runs on the api's background boot chain, so a shutdown can
    // finish while start() is awaiting a transport probe. The re-checks of
    // `started` inside start() must then bail before spawning poll loops.
    let releaseGetMe: (() => void) | undefined;
    const pollSpy = vi.fn(async function* (): AsyncIterable<never> {
      // yields nothing; the assertion is that it is never invoked at all
    });
    // `getMe` is a duck-typed capability (`hasGetMe` in host.ts), not a
    // `ChannelTransport` member, so the intersection declares it honestly.
    const slowTransport: ChannelTransport & { getMe(): Promise<{ username?: string }> } = {
      channelType: "slow",
      verifyWebhook: () => null,
      parseUpdate: () => null,
      send: async (conversationKey: string) => ({ conversationKey, messageId: "1" }),
      sendMedia: async (conversationKey: string) => ({ conversationKey, messageId: "m" }),
      sendGatePrompt: async (conversationKey: string) => ({ conversationKey, messageId: "g" }),
      updateGatePrompt: async () => {},
      answerCallback: async () => {},
      getMe: () =>
        new Promise((res) => {
          releaseGetMe = () => res({ username: "slow" });
        }),
      poll: pollSpy,
    };
    await engineCredentials.save({ type: "org", id: ORG_ID }, "slow", {
      type: "bot_token",
      accessToken: "slow-bot-token",
    });
    const slowHost = new ChannelHost({
      db: testDb.appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [
        {
          name: "slow",
          version: "0",
          transports: [{ channelType: "slow", create: () => slowTransport }],
        },
      ],
      resolveOrgId: async () => ORG_ID,
    });

    const startP = slowHost.start();
    // Wait until start() is parked on the getMe probe.
    while (!releaseGetMe) await new Promise((r) => setTimeout(r, 5));
    await slowHost.stop();
    releaseGetMe();
    await startP;

    expect(pollSpy).not.toHaveBeenCalled();
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

  it.each(["m", null])("uses current defaults for a new DM thread when the model is %s", async (model) => {
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    await testDb.appDb.insert(users).values({
      id: USER_ID, email: "channel-model@example.com", name: "Channel user",
      defaultModel: "claude-opus-4-5", defaultReasoning: "high",
    });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, { type: "user", id: USER_ID }, {
      actorUserId: USER_ID, orgId: ORG_ID,
    });
    const oldThread = await session.createThread("fake:old");
    await testDb.appDb.update(users).set({ defaultModel: model, defaultReasoning: null }).where(eq(users.id, USER_ID));
    const resolver = vi.spyOn(engineHost, "resolveFreshThreadSettings");

    await host.handleUpdate("fake", inbound());

    const thread = await session.threadByKey("fake:99");
    expect(thread?.modelId()).toBe(model ?? "s");
    expect(thread?.reasoning()).toBeUndefined();
    if (!thread) throw new Error("Expected the channel thread to exist");
    expect(await engineStore.getThread(session.id, thread.id)).toMatchObject({ model: model ?? "s", reasoning: "off" });
    expect(oldThread.modelId()).toBe("claude-opus-4-5");
    expect(session.options.modelSpec).toBe("claude-opus-4-5");
    await testDb.appDb.update(users).set({ defaultModel: "l" }).where(eq(users.id, USER_ID));
    await host.handleUpdate("fake", inbound());
    expect((await session.threadByKey("fake:99"))?.modelId()).toBe(model ?? "s");
    expect(resolver).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0);
    });
  });

  it("concurrent channel and event deliveries share one durable thread", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, {
      actorUserId: USER_ID, orgId: ORG_ID,
    });
    await Promise.all([
      host.handleUpdate("fake", inbound({ dispatchId: "concurrent-dm-1" })),
      deliverToAssistantThread({ db: testDb.appDb, engineHost }, {
        orgId: ORG_ID, owner: { type: "user", id: USER_ID }, actorUserId: USER_ID,
        threadKey: "fake:99", dispatchId: "concurrent-event",
        signal: { kind: "signal", signalType: "fake.message", body: "event", attributes: {} },
        mismatchReason: "event_target_mismatch",
      }),
    ]);
    const threads = (await engineStore.listThreads(session.id)).filter((thread) => thread.key === "fake:99");
    expect(threads).toHaveLength(1);
    expect((await session.threadByKey("fake:99"))?.id).toBe(threads[0]?.id);
  });

  it("preserves origin, sender, and attachments on direct-message ingress", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    fakeTransport.fetchedMedia = {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      name: "image.jpg",
    };
    await host.handleUpdate(
      "fake",
      inbound({ media: [{ kind: "photo", fileId: "f1", fileName: "image.jpg" }] }),
    );

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const threadId = session.thread("fake:99").id;
    let entry: Extract<Awaited<ReturnType<typeof session.providers.store.getEntries>>[number], { type: "message" }> | undefined;
    for (let i = 0; i < 50; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      const candidate = entries.find((item) => item.type === "message" && item.role === "user");
      entry = candidate?.type === "message" ? candidate : undefined;
      if (entry) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(entry?.signal).toMatchObject({
      signalType: "fake.message",
      attributes: { sender: "Ada" },
      origin: { channelType: "fake", threadKey: "fake:99" },
    });
    expect(entry?.attachments).toEqual([
      {
        type: "image",
        url: "data:image/jpeg;base64,AQID",
        mimeType: "image/jpeg",
        name: "image.jpg",
      },
    ]);
  });

  it("does not send a non-image DM attachment as a provider image block", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    fakeTransport.fetchedMedia = {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "application/pdf",
      name: "report.pdf",
    };
    await host.handleUpdate(
      "fake",
      inbound({ media: [{ kind: "document", fileId: "f2", fileName: "report.pdf" }] }),
    );

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const threadId = session.thread("fake:99").id;
    let entries: Awaited<ReturnType<typeof session.providers.store.getEntries>> = [];
    for (let i = 0; i < 50; i++) {
      entries = await session.providers.store.getEntries(session.id, threadId);
      if (entries.some((entry) => entry.type === "message" && entry.role === "assistant")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const entry = entries.find((candidate) => candidate.type === "message" && candidate.role === "user");
    expect(entry?.type === "message" ? entry.attachments : undefined).toBeUndefined();
    expect(entry?.type === "message" ? entry.content : undefined).toContain(
      "attachment skipped: unsupported media type application/pdf",
    );
    expect(entries.some((candidate) => candidate.type === "message" && candidate.role === "assistant")).toBe(true);
  });

  it("linked message is admitted on the orchestrator thread telegram-style key with dispatch dedup", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    const ev = inbound({ dispatchId: "fake:1" });
    await host.handleUpdate("fake", ev);
    await host.handleUpdate("fake", { ...ev }); // duplicate dispatchId

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const threadId = session.thread("fake:99").id;
    // The user entry is persisted asynchronously as the turn is claimed
    // (Thread.claimNext's fencedWrite, after submitPrompt's admission
    // returns) — poll briefly instead of asserting immediately.
    let userEntries: Awaited<ReturnType<typeof session.providers.store.getEntries>> = [];
    for (let i = 0; i < 50; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
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

  it("posts the first response for an addressed turn", async () => {
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const content: SignalContent = {
      kind: "signal",
      signalType: "keyed.app_mention",
      body: "who are you",
      origin: { channelType: "keyed", threadKey: "keyed:D100" },
    };
    const thread = session.thread("events");
    await thread.submitPrompt(content, { dispatchId: "evt-1" });

    for (let i = 0; i < 200; i++) {
      const entries = await session.providers.store.getEntries(session.id, thread.id);
      if (entries.some((e) => e.type === "message" && e.role === "assistant" && e.stopReason === "end_turn")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(keyedTransport.sent.map((sent) => sent.message.markdown)).toEqual(["ok"]);
  });

  it("keeps an overheard turn internal without an explicit channel action", async () => {
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const content: SignalContent = {
      kind: "signal",
      signalType: "keyed.message",
      body: "a passing remark in a followed thread",
      origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual", messageTs: "1.5" },
    };
    const thread = session.thread("events");
    await thread.submitPrompt(content, { dispatchId: "evt-manual" });

    // Wait for the assistant turn to finish before checking the channel.
    for (let i = 0; i < 200; i++) {
      const entries = await session.providers.store.getEntries(session.id, thread.id);
      if (entries.some((e) => e.type === "message" && e.role === "assistant" && e.stopReason === "end_turn")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(keyedTransport.sent).toEqual([]);
  });

  // ── conversationKey ⇄ threadKey round trip ────────────────────────────
  //
  // Outbound delivery reads a stored thread key and has to rebuild the
  // conversationKey from it. The default rebuild assumes the whole address
  // fits in the thread key. When it does not, every gate prompt, command
  // result and attention DM for that transport is addressed with a key it
  // never minted.

  it("keeps the telegram-shaped default for a transport that owns no key mapping", () => {
    expect(host.channelThreadFor("fake:99")).toEqual({
      channelType: "fake",
      conversationKey: "fake:dm:99",
    });
  });

  it("rebuilds the conversationKey through the transport when it owns the mapping", () => {
    // The inbound half must produce exactly the key the outbound half reads.
    const inboundKey = "keyed:R1:D100";
    const threadKey = keyedTransport.threadKeyFromConversationKey(inboundKey);
    expect(threadKey).toBe("keyed:D100");
    expect(host.channelThreadFor(threadKey)).toEqual({
      channelType: "keyed",
      conversationKey: inboundKey,
    });
  });

  it("stops rather than guess when the transport disowns the thread key", () => {
    expect(host.channelThreadFor("keyed:a:b")).toBeNull();
  });

  it("addresses attention DMs through the transport's own direct conversation", async () => {
    await linkIdentity(testDb.appDb, { provider: "keyed", externalId: "U77", userId: USER_ID });
    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      title: "Needs you",
      body: "a gate is waiting",
    });
    // A sender id is not an address: the transport had to open the DM first.
    expect(keyedTransport.opened).toEqual(["U77"]);
    expect(keyedTransport.sent[0]?.conversationKey).toBe("keyed:R1:D-U77");
  });
});
