import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_THREAD_KEY } from "../home/context.js";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import {
  MID_TURN_DELIVERY_KEY,
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
import { eventDropLog, sessionThreads, userIdentityLinks, users } from "../schema/index.js";
import { linkIdentity, mintDeliveredLinkCode, mintLinkCode } from "./identity-links.js";
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
      scratchCaps: {},
      wakeupLimits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
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
    // A started host polls the database for child replies until it stops.
    // Unit files share one database per worker, so a host left running here
    // would claim the next file's replies.
    await host.stop();
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

  // A code the bot DMed is entered in Valet. The person it went to holds it,
  // so sending it from chat must not link their account to the requester.
  it("/start with a DMed code does not link", async () => {
    const code = await mintDeliveredLinkCode(testDb.appDb, USER_ID, "fake", "77");
    await host.handleUpdate("fake", inbound({ kind: "command", command: { name: "start", args: code } }));
    const links = await testDb.appDb.select().from(userIdentityLinks).where(eq(userIdentityLinks.provider, "fake"));
    expect(links).toHaveLength(0);
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
    expect(thread?.reasoning()).toBe("medium");
    if (!thread) throw new Error("Expected the channel thread to exist");
    expect(await engineStore.getThread(session.id, thread.id)).toMatchObject({ model: model ?? "s", reasoning: "medium" });
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

  it("records inbound channel messages as thread user activity", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    await host.handleUpdate("fake", inbound());

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const thread = session.thread("fake:99");
    const rows = await testDb.appDb
      .select({ lastUserActivityAt: sessionThreads.lastUserActivityAt })
      .from(sessionThreads)
      .where(eq(sessionThreads.id, thread.id));
    expect(rows[0]?.lastUserActivityAt).toBeGreaterThanOrEqual(thread.toThreadData().createdAt);
  });

  it("records a DM edit as a note on the conversation's thread, with no reply, and ignores an edit with no thread", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await host.handleUpdate("fake", inbound({ kind: "edit", text: "too early", previousText: "x", conversationKey: "fake:dm:55", dispatchId: "edit-0" }));
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    expect(await session.threadByKey("fake:55")).toBeNull();

    await host.handleUpdate("fake", inbound({ text: "deploy to prod", dispatchId: "msg-1" }));
    const thread = session.thread("fake:99");
    const entries = () => engineStore.getEntries(session.id, thread.id);
    await vi.waitFor(async () => expect((await entries()).some((e) => e.type === "message" && e.role === "assistant")).toBe(true));
    const replies = (await entries()).filter((e) => e.type === "message" && e.role === "assistant").length;

    await host.handleUpdate("fake", inbound({ kind: "edit", text: "deploy to staging", previousText: "deploy to prod", dispatchId: "edit-1" }));

    await vi.waitFor(async () => {
      const note = (await entries()).find((e) => e.type === "message" && e.signal?.signalType === "slack.message_changed");
      expect(note?.type === "message" ? note.content : "").toContain("Before: deploy to prod\nAfter: deploy to staging");
    });
    expect((await entries()).filter((e) => e.type === "message" && e.role === "assistant")).toHaveLength(replies);
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
        destination: { kind: "key", key: "fake:99" }, dispatchId: "concurrent-event",
        signal: { kind: "signal", signalType: "fake.message", body: "event", attributes: {} },
        mismatchReason: "event_target_mismatch",
      }),
    ]);
    const threads = (await engineStore.listThreads(session.id)).filter((thread) => thread.key === "fake:99");
    expect(threads).toHaveLength(1);
    expect((await session.threadByKey("fake:99"))?.id).toBe(threads[0]?.id);
  });

  it("publishes shared progress through a capable non-Slack transport", async () => {
    const publish = vi.fn(async () => ({ messageId: "progress-1" }));
    Object.assign(keyedTransport, { publishProgress: publish });
    await linkIdentity(testDb.appDb, { provider: "keyed", externalId: "77", userId: USER_ID });
    await host.handleUpdate("keyed", inbound({ conversationKey: "keyed:R1:99", text: "Check the change" }));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      "keyed:R1:99", expect.objectContaining({ turnId: expect.any(String), revision: expect.any(String), tasks: expect.any(Array) }),
      expect.objectContaining({ idempotencyKey: expect.any(String), threadTs: "99" }),
    ), { timeout: 5000 });
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

  it("puts a Slack DM in the person's home thread and keeps the DM as the reply origin", async () => {
    const slack: ChannelTransport = {
      channelType: "slack",
      verifyWebhook: () => null,
      parseUpdate: () => null,
      threadKeyFromConversationKey: (key: string) => `slack:${key.split(":")[2]}:${key.split(":")[3]}`,
      conversationKeyFromThreadKey: () => null,
      send: async (conversationKey: string) => ({ conversationKey, messageId: "1" }),
      sendMedia: async (conversationKey: string) => ({ conversationKey, messageId: "m" }),
      sendGatePrompt: async (conversationKey: string) => ({ conversationKey, messageId: "g" }),
      updateGatePrompt: async () => {},
    };
    await engineCredentials.save({ type: "org", id: ORG_ID }, "slack", { type: "bot_token", accessToken: "slack-bot-token" });
    const slackHost = new ChannelHost({ db: testDb.appDb, engineHost, engineStore, eventStream, engineCredentials,
      plugins: [{ name: "slack-test", version: "0", transports: [{ channelType: "slack", create: () => slack }] }],
      resolveOrgId: async () => ORG_ID });
    await slackHost.start();
    try {
      await linkIdentity(testDb.appDb, { provider: "slack", externalId: "77", userId: USER_ID });
      const admission = vi.spyOn(engineStore, "admitSubmission");
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", text: "what is on today?" }));
      // A reply waits for the running turn. It never cancels it.
      expect(admission.mock.calls[0][3]?.steer).toBeUndefined();
      expect(admission.mock.calls[0][2].metadata?.[MID_TURN_DELIVERY_KEY]).toBe(true);
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.threadByKey(HOME_THREAD_KEY);
      expect(home).not.toBeNull();
      expect((await engineStore.getThread(session.id, home!.id))?.queueMode).toBe("followup");
      expect(await session.threadByKey("slack:D1:111.1")).toBeNull();
      let entry: Extract<Awaited<ReturnType<typeof session.providers.store.getEntries>>[number], { type: "message" }> | undefined;
      for (let i = 0; i < 50 && !entry; i++) {
        const found = (await session.providers.store.getEntries(session.id, home!.id)).find((item) => item.type === "message" && item.role === "user");
        entry = found?.type === "message" ? found : undefined;
        if (!entry) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(entry?.signal).toMatchObject({ signalType: "slack.message", origin: { channelType: "slack", threadKey: "slack:D1:111.1", reply: "auto" } });
      expect(entry?.author).toMatchObject({ id: USER_ID, interactive: true, directChannel: true });
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      const replies = (await engineStore.getEntries(session.id, home!.id)).filter(e => e.type === "message" && e.role === "assistant").length;
      await slackHost.handleUpdate("slack", inbound({ kind: "edit", conversationKey: "slack:T1:D1:111.1", text: "what is on tomorrow?", previousText: "what is on today?", dispatchId: "home-dm-edit" }));
      await vi.waitFor(async () => {
        const entries = await engineStore.getEntries(session.id, home!.id);
        expect(entries.some(e => e.type === "message" && e.signal?.signalType === "slack.message_changed" && e.content.includes("After: what is on tomorrow?"))).toBe(true);
        expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0);
      });
      const after = await engineStore.getEntries(session.id, home!.id);
      expect(after.filter(e => e.type === "message" && e.role === "assistant")).toHaveLength(replies);
      // Only a whole-message stop phrase asks to interrupt the sender's turn.
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", text: "Stop.", dispatchId: "home-dm-stop" }));
      expect(admission.mock.calls.at(-1)?.[3]).toMatchObject({ steer: true, steerScope: "active-origin" });
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
    } finally {
      await slackHost.stop();
    }
  });

  it("keeps another Slack DM queued without answering or cancelling the first DM's question", async () => {
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "home-question", name: "ask_question", arguments: { question: "Which repo?" } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("First reply"), fauxAssistantMessage("Second reply"),
    ]);
    const slack: ChannelTransport = {
      channelType: "slack", verifyWebhook: () => null, parseUpdate: () => null,
      threadKeyFromConversationKey: key => `slack:${key.split(":")[2]}:${key.split(":")[3]}`,
      conversationKeyFromThreadKey: key => `slack:T1:${key.slice(6)}`,
      send: async conversationKey => ({ conversationKey, messageId: "reply" }),
      sendMedia: async conversationKey => ({ conversationKey, messageId: "media" }),
      sendGatePrompt: async conversationKey => ({ conversationKey, messageId: "question-card" }), updateGatePrompt: async () => {},
    };
    await engineCredentials.save({ type: "org", id: ORG_ID }, "slack", { type: "bot_token", accessToken: "slack-bot-token" });
    const slackHost = new ChannelHost({ db: testDb.appDb, engineHost, engineStore, eventStream, engineCredentials,
      plugins: [{ name: "slack-test", version: "0", transports: [{ channelType: "slack", create: () => slack }] }], resolveOrgId: async () => ORG_ID });
    await slackHost.start();
    try {
      await linkIdentity(testDb.appDb, { provider: "slack", externalId: "77", userId: USER_ID });
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:first", conversationKey: "slack:T1:D1:111.1", text: "Help with this repo" }));
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.threadByKey(HOME_THREAD_KEY);
      if (!home) throw new Error("Expected Home thread");
      await vi.waitFor(() => expect(home.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const gate = home.pendingDecisionGates()[0];
      if (!gate) throw new Error("Expected question");
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:second", conversationKey: "slack:T1:D1:222.2", text: "What is the weather?" }));
      expect(home.pendingDecisionGates().map(g => g.id)).toContain(gate.id);
      expect((await engineStore.getQueueItem(session.id, gate.queueItemId))?.status).toBe("blocked_on_decision_gate");
      const queued = await engineStore.getQueueItemByDispatchId(session.id, "slack:second");
      expect(queued?.content).toMatchObject({ kind: "signal", body: "What is the weather?" });
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:answer", conversationKey: "slack:T1:D1:111.1", text: "org/repo" }));
      expect(home.pendingDecisionGates()).toHaveLength(0);
      await home.awaitResult(gate.queueItemId);
      if (!queued) throw new Error("Expected queued second request");
      await home.awaitResult(queued.id);
      expect((await engineStore.getQueueItem(session.id, gate.queueItemId))?.outcome?.outcome).toBe("completed");
      expect((await engineStore.getQueueItem(session.id, queued.id))?.outcome?.outcome).toBe("completed");
    } finally { await slackHost.stop(); }
  });

  it("keeps a reply in a DM thread that already has its own Valet thread there", async () => {
    const slack: ChannelTransport = {
      channelType: "slack",
      verifyWebhook: () => null,
      parseUpdate: () => null,
      threadKeyFromConversationKey: (key: string) => `slack:${key.split(":")[2]}:${key.split(":")[3]}`,
      conversationKeyFromThreadKey: () => null,
      send: async (conversationKey: string) => ({ conversationKey, messageId: "1" }),
      sendMedia: async (conversationKey: string) => ({ conversationKey, messageId: "m" }),
      sendGatePrompt: async (conversationKey: string) => ({ conversationKey, messageId: "g" }),
      updateGatePrompt: async () => {},
    };
    await engineCredentials.save({ type: "org", id: ORG_ID }, "slack", { type: "bot_token", accessToken: "slack-bot-token" });
    const slackHost = new ChannelHost({ db: testDb.appDb, engineHost, engineStore, eventStream, engineCredentials,
      plugins: [{ name: "slack-test", version: "0", transports: [{ channelType: "slack", create: () => slack }] }],
      resolveOrgId: async () => ORG_ID });
    await slackHost.start();
    try {
      await linkIdentity(testDb.appDb, { provider: "slack", externalId: "77", userId: USER_ID });
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const old = await session.createThread("slack:D1:099.9", {});
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:099.9", text: "following up" }));
      let entry: Extract<Awaited<ReturnType<typeof session.providers.store.getEntries>>[number], { type: "message" }> | undefined;
      for (let i = 0; i < 50 && !entry; i++) {
        const found = (await session.providers.store.getEntries(session.id, old.id)).find((item) => item.type === "message" && item.role === "user");
        entry = found?.type === "message" ? found : undefined;
        if (!entry) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(entry?.content).toContain("following up");
      expect(await session.threadByKey(HOME_THREAD_KEY)).toBeNull();
    } finally {
      await slackHost.stop();
    }
  });

  it("delivers a PDF DM attachment as a sandbox file, never as a provider image block", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    const pdf = new Uint8Array(
      readFileSync(new URL("../services/__fixtures__/sample.pdf", import.meta.url)),
    );
    fakeTransport.fetchedMedia = {
      data: pdf,
      mimeType: "application/pdf",
      name: "report.pdf",
    };
    await host.handleUpdate(
      "fake",
      inbound({ dispatchId: "attachment-replay", media: [{ kind: "document", fileId: "f2", fileName: "report.pdf" }] }),
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
    const attachments = entry?.type === "message" ? entry.attachments : undefined;
    // A PDF reaches the agent as a file on disk with its text beside it. The
    // engine renders that as a path the agent reads with its ordinary tools.
    expect(attachments).toEqual([
      {
        type: "file",
        path: "/workspace/uploads/report.pdf",
        bytes: pdf.byteLength,
        sha256: expect.any(String),
        mimeType: "application/pdf",
        markdownPath: "/workspace/uploads/report.pdf.md",
        name: "report.pdf",
      },
    ]);
    // The reason this path was image-only: a PDF sent as an image block is a
    // provider error. Keep that pinned.
    expect(attachments?.every((a) => a.type !== "image")).toBe(true);
    expect(entry?.type === "message" ? entry.content : undefined).not.toContain(
      "attachment skipped",
    );
    expect(entries.some((candidate) => candidate.type === "message" && candidate.role === "assistant")).toBe(true);
    const fetchAgain = vi.spyOn(fakeTransport, "fetchMedia");
    const replayHost = new ChannelHost({ db: testDb.appDb, engineHost, engineStore, eventStream, engineCredentials,
      plugins: [{ name: "fake", version: "0", transports: [{ channelType: "fake", create: () => fakeTransport }] }],
      resolveOrgId: async () => ORG_ID });
    await replayHost.start();
    try {
      await replayHost.handleUpdate("fake", inbound({ dispatchId: "attachment-replay", media: [{ kind: "document", fileId: "f2", fileName: "report.pdf" }] }), true);
      expect(fetchAgain).not.toHaveBeenCalled();
    } finally { await replayHost.stop(); }

  });

  it("falls back to a skipped note when a channel file cannot be stored", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    fakeTransport.fetchedMedia = {
      data: new Uint8Array([1, 2, 3]),
      // No basename survives sanitizing, so the write never happens.
      mimeType: "application/octet-stream",
      name: "..",
    };
    await host.handleUpdate(
      "fake",
      inbound({ dispatchId: "unstorable-1", media: [{ kind: "document", fileId: "f3", fileName: ".." }] }),
    );

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "user", id: USER_ID },
      { actorUserId: USER_ID, orgId: ORG_ID },
    );
    const threadId = session.thread("fake:99").id;
    let entry: { content?: string; attachments?: unknown } | undefined;
    for (let i = 0; i < 50; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      const candidate = entries.find((item) => item.type === "message" && item.role === "user");
      entry = candidate?.type === "message" ? candidate : undefined;
      if (entry) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Losing the message because one attachment failed would be worse than
    // losing the attachment, so the text still says what happened.
    expect(entry?.attachments).toBeUndefined();
    expect(entry?.content).toContain("attachment skipped");
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

  it("malformed gate_callback answers expired so Slack clears the spinner", async () => {
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await host.handleUpdate("fake", inbound({ kind: "gate_callback", gateCallback: undefined }));

    expect(fakeTransport.answered).toEqual([{ callbackId: "", text: "This approval has expired — resolve it on the web." }]);
    const drops = await testDb.appDb.select().from(eventDropLog);
    expect(drops.some((d) => d.reason === "malformed_callback")).toBe(true);
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
