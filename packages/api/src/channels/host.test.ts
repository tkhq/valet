import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_THREAD_KEY } from "../home/context.js";
import { readFileSync } from "node:fs";
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
import { eventDropLog, sessionThreads, userIdentityLinks, users } from "../schema/index.js";
import { linkIdentity, mintDeliveredLinkCode, mintLinkCode } from "./identity-links.js";
import { ChannelHost } from "./host.js";
import { bindConversation } from "./conversation-bindings.js";
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

  async function startSlackHost(extra: Partial<ChannelTransport> = {}) {
    const slack = {
      ...extra,
      channelType: "slack",
      verifyWebhook: () => null,
      parseUpdate: () => null,
      threadKeyFromConversationKey: (key: string) => `slack:${key.split(":")[2]}:${key.split(":")[3]}`,
      conversationKeyFromThreadKey: (key: string) => `slack:T1:${key.slice(6)}`,
      send: vi.fn(async (conversationKey: string, _message: OutboundChannelMessage) => ({ conversationKey, messageId: "reply" })),
      sendMedia: async (conversationKey: string) => ({ conversationKey, messageId: "media" }),
      sendGatePrompt: vi.fn(async (conversationKey: string) => ({ conversationKey, messageId: "question-card" })),
      updateGatePrompt: async () => {},
    } satisfies ChannelTransport;
    await engineCredentials.save({ type: "org", id: ORG_ID }, "slack", { type: "bot_token", accessToken: "slack-bot-token" });
    const slackHost = new ChannelHost({
      db: testDb.appDb, engineHost, engineStore, eventStream, engineCredentials,
      plugins: [{ name: "slack-test", version: "0", transports: [{ channelType: "slack", create: () => slack }] }],
      resolveOrgId: async () => ORG_ID,
    });
    await slackHost.start();
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "77", userId: USER_ID });
    return { slackHost, slack };
  }

  it("creates a native Slack DM thread without Home and records edits there without replying", async () => {
    const { slackHost } = await startSlackHost();
    try {
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:new", conversationKey: "slack:T1:D1:111.1", text: "what is on today?" }));
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      expect(await session.threadByKey(HOME_THREAD_KEY)).toBeNull();
      const thread = await session.threadByKey("slack:D1:111.1");
      if (!thread) throw new Error("Expected native Slack thread");
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      const before = await engineStore.getEntries(session.id, thread.id);
      const entry = before.find(item => item.type === "message" && item.role === "user");
      expect(entry?.type === "message" ? entry.signal : undefined).toMatchObject({
        signalType: "slack.message", origin: { channelType: "slack", threadKey: "slack:D1:111.1" },
      });
      expect(entry?.type === "message" ? entry.author : undefined).toMatchObject({
        id: USER_ID, name: inbound().sender.displayName, externalId: "77", interactive: true, directChannel: true,
      });
      expect(entry?.type === "message" ? entry.channel : undefined).toEqual({ channelType: "slack", channelId: "slack:T1:D1:111.1" });
      const replies = before.filter(e => e.type === "message" && e.role === "assistant").length;
      expect(replies).toBeGreaterThan(0);
      await slackHost.handleUpdate("slack", inbound({ kind: "edit", conversationKey: "slack:T1:D1:111.1", text: "what is on tomorrow?", previousText: "what is on today?", dispatchId: "slack:new-edit" }));
      await vi.waitFor(async () => {
        const entries = await engineStore.getEntries(session.id, thread.id);
        expect(entries.some(e => e.type === "message" && e.signal?.signalType === "slack.message_changed" && e.content.includes("After: what is on tomorrow?"))).toBe(true);
        expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0);
      });
      const after = await engineStore.getEntries(session.id, thread.id);
      expect(after.filter(e => e.type === "message" && e.role === "assistant")).toHaveLength(replies);
      expect(await session.threadByKey(HOME_THREAD_KEY)).toBeNull();
    } finally {
      await slackHost.stop();
    }
  });

  it("shows a group DM turn's status, tells the assistant the group reads its reply, and seeds the thread once", async () => {
    const fetchThreadWindow = vi.fn(async () => "[Grace] did the deploy finish?");
    const setStatus = vi.fn(async () => {});
    const { slackHost } = await startSlackHost({ fetchThreadWindow, setStatus });
    try {
      const key = "slack:T1:C0GROUP:111.1";
      await slackHost.handleUpdate("slack", inbound({
        dispatchId: "slack:group-1", conversationKey: key, text: "can you check?", threadTs: "111.1",
        group: { channelId: "C0GROUP", messageTs: "111.5" },
      }));
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const thread = await session.threadByKey("slack:C0GROUP:111.1");
      if (!thread) throw new Error("Expected the group conversation's thread");
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      expect(fetchThreadWindow).toHaveBeenCalledWith("C0GROUP", "111.1", "0", "111.5");
      expect(setStatus).toHaveBeenCalledWith(key, "111.1", "is thinking…");
      const userTurns = async () => (await engineStore.getEntries(session.id, thread.id))
        .filter((e) => e.type === "message" && e.role === "user").map((e) => e.type === "message" ? e.content : "");
      const [first] = await userTurns();
      expect(first).toContain("Everyone in it reads your reply");
      expect(first).toContain("Conversation so far in this thread:\n[Grace] did the deploy finish?");
      expect(first).toContain("can you check?");

      await slackHost.handleUpdate("slack", inbound({
        dispatchId: "slack:group-2", conversationKey: key, text: "and the tests?", threadTs: "111.1",
        group: { channelId: "C0GROUP", messageTs: "111.9" },
      }));
      await vi.waitFor(async () => expect(await userTurns()).toHaveLength(2));
      const second = (await userTurns())[1];
      expect(second).toContain("Everyone in it reads your reply");
      expect(second).not.toContain("Conversation so far");
      expect(fetchThreadWindow).toHaveBeenCalledTimes(1);
    } finally {
      await slackHost.stop();
    }
  });

  it("keeps Slack DM questions, answers, and reply origins in separate native threads", async () => {
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "repo-question", name: "ask_question", arguments: { question: "Which repo?", intent: "Ask the person a question before continuing." } }], { stopReason: "toolUse" }),
      fauxAssistantMessage([{ type: "toolCall", id: "city-question", name: "ask_question", arguments: { question: "Which city?", intent: "Ask the person a question before continuing." } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("Weather reply"), fauxAssistantMessage("Repo reply"),
    ]);
    const { slackHost, slack } = await startSlackHost();
    try {
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:first", conversationKey: "slack:T1:D1:111.1", text: "Help with this repo" }));
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const first = await session.threadByKey("slack:D1:111.1");
      if (!first) throw new Error("Expected first Slack thread");
      await vi.waitFor(() => expect(first.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const firstGate = first.pendingDecisionGates()[0];
      if (!firstGate) throw new Error("Expected repo question");
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:second", conversationKey: "slack:T1:D1:222.2", text: "What is the weather?" }));
      const second = await session.threadByKey("slack:D1:222.2");
      if (!second) throw new Error("Expected second Slack thread");
      expect(second.id).not.toBe(first.id);
      await vi.waitFor(() => expect(second.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const secondGate = second.pendingDecisionGates()[0];
      if (!secondGate) throw new Error("Expected city question");
      await vi.waitFor(() => {
        expect(slack.sendGatePrompt.mock.calls.map(([key]) => key)).toEqual(["slack:T1:D1:111.1", "slack:T1:D1:222.2"]);
      });
      expect(first.pendingDecisionGates().map(g => g.id)).toContain(firstGate.id);
      expect(await engineStore.getQueueItemByDispatchId(session.id, "slack:first")).toMatchObject({
        threadId: first.id, content: { kind: "signal", origin: { channelType: "slack", threadKey: "slack:D1:111.1" } },
      });
      expect(await engineStore.getQueueItemByDispatchId(session.id, "slack:second")).toMatchObject({
        threadId: second.id, content: { kind: "signal", origin: { channelType: "slack", threadKey: "slack:D1:222.2" } },
      });

      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:city-answer", conversationKey: "slack:T1:D1:222.2", text: "Boston" }));
      await second.awaitResult(secondGate.queueItemId);
      expect(first.pendingDecisionGates().map(g => g.id)).toContain(firstGate.id);
      expect((await engineStore.getQueueItem(session.id, firstGate.queueItemId))?.status).toBe("blocked_on_decision_gate");
      expect(await engineStore.getDecisionGate(session.id, secondGate.id)).toMatchObject({
        status: "resolved", resolution: { value: "Boston", source: { channelId: "slack:T1:D1:222.2", messageId: "slack:city-answer" } },
      });
      await slackHost.handleUpdate("slack", inbound({ dispatchId: "slack:repo-answer", conversationKey: "slack:T1:D1:111.1", text: "org/repo" }));
      await first.awaitResult(firstGate.queueItemId);
      expect(await engineStore.getDecisionGate(session.id, firstGate.id)).toMatchObject({
        status: "resolved", resolution: { value: "org/repo", source: { channelId: "slack:T1:D1:111.1", messageId: "slack:repo-answer" } },
      });
      expect(await engineStore.getQueueItemByDispatchId(session.id, "slack:city-answer")).toBeNull();
      expect(await engineStore.getQueueItemByDispatchId(session.id, "slack:repo-answer")).toBeNull();
      await vi.waitFor(() => {
        expect(slack.send.mock.calls.some(([key, message]) => key === "slack:T1:D1:222.2" && message.markdown.includes("Weather reply"))).toBe(true);
        expect(slack.send.mock.calls.some(([key, message]) => key === "slack:T1:D1:111.1" && message.markdown.includes("Repo reply"))).toBe(true);
      });
      expect(await session.threadByKey(HOME_THREAD_KEY)).toBeNull();
    } finally {
      await slackHost.stop();
    }
  });

  it.each([false, true])("keeps an existing Slack conversation in its original destination: native=%s", async (nativeExists) => {
    const { slackHost } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.createThread(HOME_THREAD_KEY);
      await home.setMode("followup");
      const original = await home.recordSignal({
        kind: "signal", signalType: "slack.message", body: "original message",
        origin: { channelType: "slack", threadKey: "slack:D1:099.9" },
      }, { dispatchId: "slack:legacy", author: { id: USER_ID } });
      await home.awaitResult(original.queueItemId);
      const homeBefore = await engineStore.getEntries(session.id, home.id);
      const native = nativeExists ? await session.createThread("slack:D1:099.9") : null;
      const expected = native ?? home;
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:099.9", text: "following up", dispatchId: "slack:followup" }), true);
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      expect(await engineStore.getQueueItemByDispatchId(session.id, "slack:followup")).toMatchObject({ threadId: expected.id });
      expect((await engineStore.getThread(session.id, home.id))?.queueMode).toBe("followup");
      if (native) expect(await engineStore.getEntries(session.id, home.id)).toEqual(homeBefore);
      else expect(await session.threadByKey("slack:D1:099.9")).toBeNull();
    } finally { await slackHost.stop(); }
  });

  it.each([true, false])("records repeated edits only in the proven legacy conversation: matches=%s", async (matches) => {
    const { slackHost, slack } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.createThread(HOME_THREAD_KEY);
      const receipt = await home.recordSignal({
        kind: "signal", signalType: "slack.message", body: "version one",
        origin: { channelType: "slack", threadKey: matches ? "slack:D1:111.1" : "slack:D1:999.9" },
      }, { dispatchId: "slack:legacy", author: { id: USER_ID } });
      await home.awaitResult(receipt.queueItemId);
      const before = await engineStore.getEntries(session.id, home.id);
      for (const [index, previousText, text] of [[1, "version one", "version two"], [2, "version two", "version three"]] as const) {
        await slackHost.handleUpdate("slack", inbound({ kind: "edit", conversationKey: "slack:T1:D1:111.1", previousText, text, dispatchId: `slack:edit-${index}` }), true);
        await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      }
      const after = await engineStore.getEntries(session.id, home.id);
      expect(after).toHaveLength(before.length + (matches ? 2 : 0));
      if (matches) expect(after.at(-1)).toMatchObject({ type: "message", content: expect.stringContaining("After: version three") });
      expect(slack.send).not.toHaveBeenCalled();
      expect(await session.threadByKey("slack:D1:111.1")).toBeNull();
    } finally { await slackHost.stop(); }
  });

  it("keeps a Home binding after restart even when a native thread later exists", async () => {
    faux.setResponses([fauxAssistantMessage("Before restart"), fauxAssistantMessage("After restart")]);
    let { slackHost } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.createThread(HOME_THREAD_KEY);
      const seed = await home.recordSignal({ kind: "signal", signalType: "slack.message", body: "original", origin: { channelType: "slack", threadKey: "slack:D1:111.1" } }, { dispatchId: "legacy-seed", author: { id: USER_ID } });
      await home.awaitResult(seed.queueItemId);
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", text: "before restart", dispatchId: "before-restart" }), true);
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      expect((await engineStore.getQueueItemByDispatchId(session.id, "before-restart"))?.threadId).toBe(home.id);
      const native = await session.createThread("slack:D1:111.1");
      await slackHost.stop();
      engineHost.evictAll({ shutdown: false });
      ({ slackHost } = await startSlackHost());
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", text: "after restart", dispatchId: "after-restart" }), true);
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      expect((await engineStore.getQueueItemByDispatchId(session.id, "after-restart"))?.threadId).toBe(home.id);
      expect(await engineStore.getEntries(session.id, native.id)).toHaveLength(0);
    } finally { await slackHost.stop(); }
  });

  it("answers a pending Home question from the old Slack root while a new root stays separate", async () => {
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "legacy-question", name: "ask_question", arguments: { question: "Which repository?", intent: "Ask the person a question before continuing." } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("Separate answer"), fauxAssistantMessage("Legacy answer"),
    ]);
    const { slackHost, slack } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const home = await session.createThread(HOME_THREAD_KEY);
      await home.setMode("followup");
      await home.submitPrompt({ kind: "signal", signalType: "slack.message", body: "Help", origin: { channelType: "slack", threadKey: "slack:D1:111.1" } }, {
        dispatchId: "legacy-question", author: { id: USER_ID, interactive: true, directChannel: true }, channel: { channelType: "slack", channelId: "slack:T1:D1:111.1" },
      });
      await vi.waitFor(() => expect(home.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const gate = home.pendingDecisionGates()[0];
      if (!gate) throw new Error("Expected legacy question");
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:222.2", text: "Separate task", dispatchId: "separate-task" }), true);
      const native = await session.threadByKey("slack:D1:222.2");
      if (!native) throw new Error("Expected separate Slack chat");
      await native.awaitResult((await engineStore.getQueueItemByDispatchId(session.id, "separate-task"))?.id ?? "missing");
      expect(home.pendingDecisionGates().map(g => g.id)).toContain(gate.id);
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", text: "sample/repo", dispatchId: "legacy-answer" }), true);
      await vi.waitFor(async () => expect((await engineStore.getDecisionGate(session.id, gate.id))?.status).toBe("resolved"), { timeout: 10_000 });
      await home.awaitResult(gate.queueItemId);
      expect(await engineStore.getDecisionGate(session.id, gate.id)).toMatchObject({ status: "resolved", resolution: { value: "sample/repo", source: { channelId: "slack:T1:D1:111.1" } } });
      expect(await engineStore.getQueueItemByDispatchId(session.id, "legacy-answer")).toBeNull();
      expect(await session.threadByKey("slack:D1:111.1")).toBeNull();
      await vi.waitFor(() => expect(slack.send.mock.calls.some(([key, message]) => key === "slack:T1:D1:111.1" && message.markdown.includes("Legacy answer"))).toBe(true));
    } finally { await slackHost.stop(); }
  });

  it("admits concurrent retries on one native chat without duplicating history", async () => {
    const { slackHost } = await startSlackHost();
    try {
      const event = inbound({ conversationKey: "slack:T1:D1:111.1", text: "One request", dispatchId: "slack:concurrent-retry" });
      await Promise.all([slackHost.handleUpdate("slack", event, true), slackHost.handleUpdate("slack", event, true)]);
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      const native = await session.threadByKey("slack:D1:111.1");
      if (!native) throw new Error("Expected native Slack chat");
      expect((await engineStore.listThreads(session.id)).filter(row => row.key === native.key)).toHaveLength(1);
      expect((await engineStore.getEntries(session.id, native.id)).filter(e => e.type === "message" && e.role === "user")).toHaveLength(1);
    } finally { await slackHost.stop(); }
  });

  it("interrupts only the Slack chat receiving a correction and keeps another chat's approval pending", async () => {
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "first-approval", name: "ask_approval", arguments: { title: "Approve the first task?", intent: "Ask the person to approve before continuing." } }], { stopReason: "toolUse" }),
      fauxAssistantMessage([{ type: "toolCall", id: "second-approval", name: "ask_approval", arguments: { title: "Approve the second task?", intent: "Ask the person to approve before continuing." } }], { stopReason: "toolUse" }),
      ...Array.from({ length: 6 }, () => fauxAssistantMessage("Updated first task")),
    ]);
    const { slackHost } = await startSlackHost();
    try {
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "first-task", text: "First task" }), true);
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const first = await session.threadByKey("slack:D1:111.1");
      if (!first) throw new Error("Expected first chat");
      await vi.waitFor(() => expect(first.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const firstGate = first.pendingDecisionGates()[0];
      if (!firstGate) throw new Error("Expected first approval");
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:222.2", dispatchId: "second-task", text: "Second task" }), true);
      const second = await session.threadByKey("slack:D1:222.2");
      if (!second) throw new Error("Expected second chat");
      await vi.waitFor(() => expect(second.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
      const secondGate = second.pendingDecisionGates()[0];
      if (!secondGate) throw new Error("Expected second approval");
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "first-correction", text: "Use the corrected approach" }), true);
      const correction = await engineStore.getQueueItemByDispatchId(session.id, "first-correction");
      if (!correction) throw new Error("Expected correction receipt");
      await first.awaitResult(correction.id);
      expect((await engineStore.getQueueItem(session.id, correction.id))?.outcome).toMatchObject({ outcome: "completed" });
      expect((await engineStore.getDecisionGate(session.id, firstGate.id))?.status).toBe("withdrawn");
      expect((await engineStore.getDecisionGate(session.id, secondGate.id))?.status).toBe("pending");
      expect(second.pendingDecisionGates().map(g => g.id)).toContain(secondGate.id);
      const firstHistory = await engineStore.getEntries(session.id, first.id);
      const secondHistory = await engineStore.getEntries(session.id, second.id);
      expect(firstHistory.some(e => e.type === "message" && e.content.includes("Second task"))).toBe(false);
      expect(secondHistory.some(e => e.type === "message" && e.content.includes("corrected approach"))).toBe(false);
    } finally { await slackHost.stop(); }
  });

  it("refuses a missing bound chat after restart instead of creating a replacement", async () => {
    let { slackHost } = await startSlackHost();
    try {
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "bound-original", text: "Original task" }), true);
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      const native = await session.threadByKey("slack:D1:111.1");
      if (!native) throw new Error("Expected bound chat");
      await slackHost.stop();
      engineHost.evictAll({ shutdown: false });
      await testDb.pgdb.query("DELETE FROM engine_threads WHERE session_id = $1 AND id = $2", [session.id, native.id]);
      ({ slackHost } = await startSlackHost());
      await expect(slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "bound-missing", text: "Follow up" }), true)).rejects.toThrow("Start a new Slack thread");
      expect(await engineStore.getQueueItemByDispatchId(session.id, "bound-missing")).toBeNull();
      expect((await engineStore.listThreads(session.id)).some(t => t.key === native.key)).toBe(false);
    } finally { await slackHost.stop(); }
  });

  it.each(["native", "home"])("finds persisted %s conversations absent from the host cache and restores their model history", async (destination) => {
    const { slackHost } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const template = await session.createThread("web:template");
      const id = "thread-from-another-host";
      await engineStore.saveThread(session.id, { ...template.toThreadData(), id, key: destination === "home" ? HOME_THREAD_KEY : "slack:D1:111.1" });
      await engineStore.appendEntries(session.id, id, [{
        id: "earlier-entry", sessionId: session.id, threadId: id, parentId: null, type: "message", role: "user", content: "Earlier saved decision",
        parts: [{ type: "text", text: "Earlier saved decision" }], createdAt: 1,
        signal: { signalType: "slack.message", tagName: "slack-message", origin: { channelType: "slack", threadKey: "slack:D1:111.1" } },
      }]);
      let context = "";
      faux.setResponses([input => { context = JSON.stringify(input.messages); return fauxAssistantMessage("Continued saved work"); }]);
      expect(session.threadById(id)).toBeNull();
      await slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "late-thread-reply", text: "Continue the saved work" }), true);
      await vi.waitFor(async () => expect(await engineStore.listUnsettledSubmissions(session.id)).toHaveLength(0));
      expect((await engineStore.getQueueItemByDispatchId(session.id, "late-thread-reply"))?.threadId).toBe(id);
      expect(context).toContain("Earlier saved decision");
      if (destination === "home") expect(await session.threadByKey("slack:D1:111.1")).toBeNull();
    } finally { await slackHost.stop(); }
  });

  it("refuses a bound chat deleted during lookup without creating or admitting a replacement", async () => {
    const { slackHost } = await startSlackHost();
    try {
      const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
      const template = await session.createThread("web:template");
      const id = "thread-deleted-during-lookup";
      await engineStore.saveThread(session.id, { ...template.toThreadData(), id, key: "slack:D1:111.1" });
      await bindConversation(testDb.appDb, { orgId: ORG_ID, userId: USER_ID, sessionId: session.id, channelType: "slack", conversationKey: "slack:T1:D1:111.1" }, id);
      const read = engineStore.getThread.bind(engineStore);
      vi.spyOn(engineStore, "getThread").mockImplementationOnce(async (sessionId, threadId) => {
        const data = await read(sessionId, threadId);
        await testDb.pgdb.query("DELETE FROM engine_threads WHERE session_id = $1 AND id = $2", [sessionId, threadId]);
        return data;
      });
      await expect(slackHost.handleUpdate("slack", inbound({ conversationKey: "slack:T1:D1:111.1", dispatchId: "deleted-during-lookup", text: "Continue" }), true)).rejects.toThrow("Start a new Slack thread");
      expect(await engineStore.getQueueItemByDispatchId(session.id, "deleted-during-lookup")).toBeNull();
      expect((await engineStore.listThreads(session.id)).some(t => t.key === "slack:D1:111.1")).toBe(false);
    } finally { await slackHost.stop(); }
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
