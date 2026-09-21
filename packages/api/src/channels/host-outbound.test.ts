import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import {
  VirtualSandboxProvider,
  type BusEvent,
  type ChannelGatePrompt,
  type ChannelGateResolution,
  type ChannelTransport,
  type DecisionGate,
  type GatePromptRef,
  type InboundChannelEvent,
  type OutboundChannelAttachment,
  type OutboundChannelMessage,
  type QueueItem,
  type SessionEntry,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { eq } from "drizzle-orm";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { ensureWorkflowSession } from "../workflows/engine-deps.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { agentSessions, assistants, eventDropLog, orgMembers, teamMembers, teams, users, workflowDefinitions } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import type { AttentionEvent } from "../orchestrator/attention.js";
import { linkIdentity, setNotifyAttention } from "./identity-links.js";
import {
  ChannelHost,
  FINAL_DELIVERY_RETRY_DELAY_MS,
  MAX_FINAL_DELIVERY_RETRIES,
  type ChannelHostDeps,
} from "./host.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";

class FakeTransport implements ChannelTransport {
  readonly channelType: string = "fake";
  /** Artificial latency on send(), to make delivery-order races observable. */
  sendDelayMs = 0;
  /** Number of the next sends that fail before any message is recorded. */
  sendFailures = 0;
  sendAttempts = 0;
  sendBlock: Promise<void> | undefined;
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  deliveries: Array<{ type: "message"; markdown: string } | { type: "gate"; gateId: string }> = [];
  media: Array<{ conversationKey: string; attachment: OutboundChannelAttachment }> = [];
  gatePrompts: Array<{ conversationKey: string; prompt: ChannelGatePrompt; messageId: string }> = [];
  gateEdits: Array<{ ref: GatePromptRef; resolution: ChannelGateResolution }> = [];
  answered: Array<{ callbackId: string; text?: string }> = [];
  private nextMessageId = 1;

  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    this.sendAttempts += 1;
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    if (this.sendBlock) await this.sendBlock;
    if (this.sendFailures > 0) {
      this.sendFailures -= 1;
      throw new Error("send failed");
    }
    this.sent.push({ conversationKey, message });
    this.deliveries.push({ type: "message", markdown: message.markdown });
    return { conversationKey, messageId: String(this.nextMessageId++) };
  }
  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment) {
    this.media.push({ conversationKey, attachment });
    return { conversationKey, messageId: String(this.nextMessageId++) };
  }
  async sendGatePrompt(conversationKey: string, prompt: ChannelGatePrompt) {
    const messageId = String(this.nextMessageId++);
    this.gatePrompts.push({ conversationKey, prompt, messageId });
    this.deliveries.push({ type: "gate", gateId: prompt.gateId });
    return { conversationKey, messageId };
  }
  async updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution) {
    this.gateEdits.push({ ref, resolution });
  }
  async answerCallback(callbackId: string, text?: string) {
    this.answered.push({ callbackId, text });
  }
}

/** A transport that owns its conversationKey rebuild, like Slack: the thread
 * key alone is not the address. Exercises origin-routed (events-thread)
 * delivery, which must rebuild the key through the transport. */
class KeyedTransport extends FakeTransport {
  override readonly channelType: string = "keyed";
  conversationKeyFromThreadKey(threadKey: string): string | null {
    return threadKey.startsWith("keyed:") ? `keyed:R1:${threadKey.slice("keyed:".length)}` : null;
  }
}

/**
 * The user entry a submission writes, marked with the surface it came from.
 *
 * Gate delivery reads the submission's surface, not the thread's binding.
 * One builder owns the entry shape. The wrappers select the surface under
 * test (TKAI-323).
 */
function userEntry(args: {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  text?: string;
  channel?: { channelType: string; channelId: string };
  signal?: {
    signalType: string;
    tagName: string;
    origin?: { channelType: string; threadKey: string; reply?: "auto" | "manual" };
  };
}): SessionEntry {
  return {
    type: "message",
    id: `user-${args.queueItemId}`,
    sessionId: args.sessionId,
    threadId: args.threadId,
    parentId: null,
    createdAt: Date.now(),
    role: "user",
    content: args.text ?? "do the thing",
    queueItemId: args.queueItemId,
    channel: args.channel,
    signal: args.signal,
  };
}

/** `channel` is the mark the direct-message path stamps (`ChannelHost.handleMessage`). */
function channelUserEntry(args: {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  text?: string;
}): SessionEntry {
  return userEntry({ ...args, channel: { channelType: "fake", channelId: "fake:dm:99" } });
}

/** A web-UI prompt: no `channel`, no `signal` — the one surface that stays off the channel. */
function webUserEntry(args: {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  text?: string;
}): SessionEntry {
  return userEntry(args);
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

describe("ChannelHost outbound delivery", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let host: ChannelHost;
  let fakeTransport: FakeTransport;
  let keyedTransport: KeyedTransport;
  let faux: FauxProviderRegistration;
  let eventStream: PgEventStream;
  let engineStore: PgSessionStore;
  let workflowStore: PgWorkflowStore;
  let actionPluginByService: ReturnType<typeof assemblePlugins>["actionPluginByService"];
  let engineCredentials: PgCredentialStore;

  beforeEach(async () => {
    // See host.test.ts / task-6-report.md: registerFauxProvider overwrites
    // pi-ai's internal "anthropic-messages" stream implementation so
    // EngineHost's real Model resolution (getModel("anthropic", ...)) still
    // resolves the real claude-haiku-4-5 Model object, but streaming is
    // intercepted — no ANTHROPIC_API_KEY / network needed.
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    // Pre-run credential detection: the faux stream ignores the key's value,
    // it just has to exist for the turn to start (env scrubbed by setup).
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
      actions: [
        {
          service: "fake",
          actions: [
            {
              id: "fake.do_thing",
              name: "Do thing",
              description: "a risky action that requires approval",
              riskLevel: "high",
              parameters: Type.Object({}),
              execute: async () => ({ success: true, data: "done" }),
            },
            {
              id: "fake.lookup",
              name: "Lookup",
              description: "a low-risk action that runs without approval",
              riskLevel: "low",
              parameters: Type.Object({}),
              execute: async () => ({ success: true, data: "found" }),
            },
          ],
        },
      ],
    };

    ({ actionPluginByService } = assemblePlugins([[fakePlugin]]));
    workflowStore = new PgWorkflowStore(pgdb);

    await engineCredentials.save({ type: "org", id: ORG_ID }, "fake", {
      type: "bot_token",
      accessToken: "fake-bot-token",
    });
    await engineCredentials.save({ type: "org", id: ORG_ID }, "keyed", {
      type: "bot_token",
      accessToken: "keyed-bot-token",
    });

    engineHost = new EngineHost({
      engineStore,
      sandboxProvider,
      eventStream,
      engineCredentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
      actionPluginByService,
    });

    host = new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [fakePlugin],
      workflowStore,
      actionPluginByService,
      resolveOrgId: async () => ORG_ID,
    });
    await host.start();

    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
  });

  afterEach(async () => {
    host.stopOutbound();
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function seedWorkflowGate(args: {
    workflowId: string;
    runId: string;
    workflowOrgId: string;
    owner: { ownerType: "org" | "team" | "user"; ownerId: string };
    gateId: string;
    actions?: DecisionGate["actions"];
  }): Promise<{ sessionId: string; ref: GatePromptRef }> {
    const now = Date.now();
    await testDb.appDb.insert(workflowDefinitions).values({
      id: args.workflowId,
      orgId: args.workflowOrgId,
      ownerType: args.owner.ownerType,
      ownerId: args.owner.ownerId,
      name: args.workflowId,
      definition: {},
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      args.runId,
      { workflowId: args.workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      args.owner,
    );
    const sessionId = `wf:${args.runId}:step`;
    const session = await ensureWorkflowSession({
      host: engineHost,
      store: workflowStore,
      db: testDb.appDb,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    }, sessionId);
    const threadId = session.thread().id;
    await engineStore.saveDecisionGate(sessionId, threadId, {
      id: args.gateId,
      sessionId,
      threadId,
      queueItemId: `q-${args.gateId}`,
      resumeKey: `resume-${args.gateId}`,
      ordinal: 0,
      type: "approval",
      title: "Approve workflow action?",
      actions: args.actions ?? [{ id: "approve", label: "Approve", style: "primary" }],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const ref = { conversationKey: `fake:dm:${args.gateId}`, messageId: `m-${args.gateId}` };
    host.recordGatePrompt(args.gateId, ref, sessionId);
    return { sessionId, ref };
  }

  async function callback(ref: GatePromptRef, callbackId: string, actionId = "approve"): Promise<void> {
    await host.handleUpdate("fake", inbound({
      dispatchId: `fake:${randomUUID()}`,
      kind: "gate_callback",
      gateCallback: { actionId, callbackId, ref },
    }));
  }

  it("automatically posts the first assistant text for a direct addressed turn", async () => {
    faux.setResponses([fauxAssistantMessage("internal response")]);

    await host.handleUpdate("fake", inbound({ dispatchId: `fake:${randomUUID()}` }));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["internal response"]);
  });

  it("delivers a branded command_result to the channel the command came from", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    await testDb.appDb
      .update(assistants)
      .set({ name: "Ledger", avatarUrl: "https://cdn.example.com/ledger.png" })
      .where(eq(assistants.sessionId, session.id));
    const sessionId = session.id;
    const threadId = session.thread("fake:99").id;

    const entry = {
      type: "command_result" as const,
      id: "cmd-res-1",
      sessionId,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      command: "/status",
      source: "builtin" as const,
      ok: true,
      output: "**Queue** idle (0 pending)",
      // The engine stamps the surface the command came from; only a
      // channel-typed command posts back to the channel (TKAI-323).
      channel: { channelType: "fake", channelId: "fake:dm:99" },
    };
    const event: BusEvent = {
      sessionId,
      threadId,
      timestamp: Date.now(),
      event: { type: "command_result", threadId, entry },
    };
    await eventStream.append(event, `cmd-1-${randomUUID()}`);
    await eventStream.append(event, `cmd-2-${randomUUID()}`);

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Queue"))).toBe(true);
    });
    const hit = fakeTransport.sent.find((s) => s.message.markdown.includes("Queue"));
    expect(hit?.message.markdown).toContain("/status");
    expect(hit?.message.sender).toEqual({
      displayName: "Ledger",
      avatarUrl: "https://cdn.example.com/ledger.png",
    });
    // Dedup: the second append must not double-deliver.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fakeTransport.sent.filter((s) => s.message.markdown.includes("Queue"))).toHaveLength(1);
  });

  it("ignores command_result on non-channel threads", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const sessionId = session.id;
    const threadId = session.thread("web:default").id;

    const event: BusEvent = {
      sessionId,
      threadId,
      timestamp: Date.now(),
      event: {
        type: "command_result",
        threadId,
        entry: {
          type: "command_result",
          id: "cmd-res-web",
          sessionId,
          threadId,
          parentId: null,
          createdAt: Date.now(),
          command: "/help",
          source: "builtin",
          ok: true,
          output: "web-only result",
        },
      },
    };
    await eventStream.append(event, `cmd-web-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.filter((s) => s.message.markdown.includes("web-only result"))).toHaveLength(0);
  });

  it("a web-typed command's result stays off a channel-bound thread (TKAI-323)", async () => {
    // The entry carries no `channel` mark: the command was typed in the web
    // UI, so its result answers there even though the thread is bound.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const sessionId = session.id;
    const threadId = session.thread("fake:99").id;

    const event: BusEvent = {
      sessionId,
      threadId,
      timestamp: Date.now(),
      event: {
        type: "command_result",
        threadId,
        entry: {
          type: "command_result",
          id: "cmd-res-web-bound",
          sessionId,
          threadId,
          parentId: null,
          createdAt: Date.now(),
          command: "/status",
          source: "builtin",
          ok: true,
          output: "web-typed result",
        },
      },
    };
    await eventStream.append(event, `cmd-web-bound-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.filter((s) => s.message.markdown.includes("web-typed result"))).toHaveLength(0);
  });

  it("delivers a terminal result that has no explicit origin reply", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-addressed",
        signal: {
          signalType: "keyed.message",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "auto" },
        },
      }),
      {
        type: "message", id: "first-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am on it", queueItemId: "qi-addressed",
      },
      {
        type: "message", id: "final-result", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "The work is complete", queueItemId: "qi-addressed",
        stopReason: "end_turn",
      },
    ]);
    for (const messageId of ["first-ack", "final-result"]) {
      await eventStream.append(
        { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId, reason: "end_turn" } },
        `${messageId}-${randomUUID()}`,
      );
    }

    await vi.waitFor(() => expect(keyedTransport.sent).toHaveLength(2));
    expect(keyedTransport.sent.map((sent) => sent.message.markdown)).toEqual([
      "I am on it",
      "The work is complete",
    ]);
  });

  it("retries final fallback after a transport failure without another event", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItemId = "qi-final-retry";
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId,
        signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } },
      }),
      {
        type: "message", id: "final-retry-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId,
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "final-retry-ack", reason: "end_turn" } },
      `final-retry-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "final-retry-result", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "The work is complete", queueItemId, stopReason: "end_turn",
    }]);

    fakeTransport.sendFailures = 1;
    const finalEvent = {
      sessionId: session.id,
      threadId,
      queueItemId,
      timestamp: Date.now(),
      event: { type: "message_end" as const, threadId, messageId: "final-retry-result", reason: "end_turn" as const },
    };
    await eventStream.append(finalEvent, `final-retry-failure-${randomUUID()}`);
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual([
      "I am checking",
      "The work is complete",
    ]), { timeout: FINAL_DELIVERY_RETRY_DELAY_MS * 4 });

    await eventStream.append(finalEvent, `final-retry-redelivery-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual([
      "I am checking",
      "The work is complete",
    ]);
  });

  it("does not schedule a retry when outbound stops during a failed send", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItemId = "qi-final-retry-stop";
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId,
        signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } },
      }),
      {
        type: "message", id: "final-stop-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId,
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "final-stop-ack", reason: "end_turn" } },
      `final-stop-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "final-stop-result", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "The work is complete", queueItemId, stopReason: "end_turn",
    }]);

    let releaseSend: (() => void) | undefined;
    fakeTransport.sendAttempts = 0;
    fakeTransport.sendFailures = 1;
    fakeTransport.sendBlock = new Promise<void>((resolve) => { releaseSend = resolve; });
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "final-stop-result", reason: "end_turn" } },
      `final-stop-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sendAttempts).toBe(1));
    host.stopOutbound();
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, FINAL_DELIVERY_RETRY_DELAY_MS * 3));

    expect(fakeTransport.sendAttempts).toBe(1);
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]);
  });

  it("stops retrying final fallback after the retry limit", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItemId = "qi-final-retry-exhausted";
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId,
        signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } },
      }),
      {
        type: "message", id: "final-exhausted-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId,
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "final-exhausted-ack", reason: "end_turn" } },
      `final-exhausted-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "final-exhausted-result", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "The work is complete", queueItemId, stopReason: "end_turn",
    }]);

    fakeTransport.sendFailures = MAX_FINAL_DELIVERY_RETRIES + 1;
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "final-exhausted-result", reason: "end_turn" } },
      `final-exhausted-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sendFailures).toBe(0), {
      timeout: FINAL_DELIVERY_RETRY_DELAY_MS * (MAX_FINAL_DELIVERY_RETRIES + 3),
    });
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]);
    await new Promise((resolve) => setTimeout(resolve, FINAL_DELIVERY_RETRY_DELAY_MS * 2));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]);
  });

  it("keeps an explicit later reply and does not auto-post the final result", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-later",
        signal: {
          signalType: "fake.message",
          tagName: "signal",
          origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" },
        },
      }),
      {
        type: "message", id: "later-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId: "qi-later",
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "later-ack", reason: "end_turn" } },
      `later-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent).toHaveLength(1));

    // The explicit action owns later delivery. Its persisted call prevents no
    // first post here because the acknowledgement already has its event.
    await fakeTransport.send("fake:dm:99", { markdown: "The check passed" });
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "later-final", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "internal final", queueItemId: "qi-later", stopReason: "end_turn",
      parts: [{
        type: "tool_call", callId: "tc-later", toolName: "call_tool", status: "completed",
        args: { tool_id: "fake.reply_to_origin", params: { text: "The check passed" } },
        result: { text: "ok", details: { ok: true } },
      }],
    }]);
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "later-final", reason: "end_turn" } },
      `later-final-${randomUUID()}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking", "The check passed"]);
  });

  it("falls back to the final result after a failed explicit reply and auto-ack", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const final: SessionEntry = {
      type: "message", id: "failed-final", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "The work is complete", queueItemId: "qi-failed-final",
      stopReason: "end_turn",
      parts: [{
        type: "tool_call", callId: "tc-failed-final", toolName: "call_tool", status: "running",
        args: { tool_id: "fake.reply_to_origin", params: { text: "The work is complete", final: true } },
      }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-failed-final",
        signal: {
          signalType: "fake.message",
          tagName: "signal",
          origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" },
        },
      }),
      {
        type: "message", id: "failed-final-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId: "qi-failed-final",
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId: "qi-failed-final", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "failed-final-ack", reason: "end_turn" } },
      `failed-final-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));

    await engineStore.appendEntries(session.id, threadId, [final]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId: "qi-failed-final", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: final.id, reason: "end_turn" } },
      `failed-final-message-${randomUUID()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]);

    const part = final.parts?.[0];
    if (!part || part.type !== "tool_call") throw new Error("missing final reply call");
    part.status = "completed";
    part.result = { details: { ok: false }, text: "failed" };
    await engineStore.updateEntry(session.id, threadId, final);
    const toolEnd = {
      sessionId: session.id,
      threadId,
      queueItemId: "qi-failed-final",
      timestamp: Date.now(),
      event: { type: "tool_end" as const, threadId, tool: "call_tool", callId: part.callId, result: "failed", isError: false },
    };
    await eventStream.append(toolEnd, `failed-final-tool-${randomUUID()}`);
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual([
      "I am checking",
      "The work is complete",
    ]));

    await eventStream.append(toolEnd, `failed-final-tool-redelivery-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual([
      "I am checking",
      "The work is complete",
    ]);
  });

  it.each([
    { finalState: "missing", expected: ["I am checking", "The work is complete"] },
    { finalState: "failed", expected: ["I am checking", "The work is complete"] },
    { finalState: "pending", expected: ["I am checking"] },
  ] as const)("does not let successful progress suppress a $finalState final reply", async ({ finalState, expected }) => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItemId = `qi-progress-${finalState}`;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId,
        signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } },
      }),
      {
        type: "message", id: `progress-ack-${finalState}`, sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId,
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: `progress-ack-${finalState}`, reason: "end_turn" } },
      `progress-ack-${finalState}-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));

    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: `progress-${finalState}`, sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "Progress update", queueItemId,
      parts: [{
        type: "tool_call", callId: `tc-progress-${finalState}`, toolName: "call_tool", status: "completed",
        args: { tool_id: "fake.reply_to_origin", params: { text: "Progress update" } },
        result: { details: { ok: true }, text: "sent" },
      }],
    }]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: `progress-${finalState}`, reason: "tool_use" } },
      `progress-message-${finalState}-${randomUUID()}`,
    );

    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: `progress-final-${finalState}`, sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 2, role: "assistant", content: "The work is complete", queueItemId, stopReason: "end_turn",
      ...(finalState === "missing" ? {} : {
        parts: [{
          type: "tool_call", callId: `tc-final-${finalState}`, toolName: "call_tool",
          status: finalState === "pending" ? "running" : "completed",
          args: { tool_id: "fake.reply_to_origin", params: { text: "The work is complete", final: true } },
          ...(finalState === "failed" ? { result: { details: { ok: false }, text: "failed" } } : {}),
        }],
      }),
    }]);
    await eventStream.append(
      { sessionId: session.id, threadId, queueItemId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: `progress-final-${finalState}`, reason: "end_turn" } },
      `progress-final-${finalState}-${randomUUID()}`,
    );
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(expected));
  });

  it("keeps an unaddressed response silent", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-overheard",
        signal: {
          signalType: "keyed.message",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual" },
        },
      }),
      {
        type: "message", id: "overheard-response", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "internal response", queueItemId: "qi-overheard", stopReason: "end_turn",
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "overheard-response", reason: "end_turn" } },
      `overheard-${randomUUID()}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(keyedTransport.sent).toHaveLength(0);
  });

  it("does not auto-post a child.settled turn with an inherited manual origin", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-child-settled",
        signal: {
          signalType: "child.settled",
          tagName: "signal",
          origin: { channelType: "fake", threadKey: "fake:99", reply: "manual" },
        },
      }),
      {
        type: "message", id: "child-settled-response", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "internal child result", queueItemId: "qi-child-settled", stopReason: "end_turn",
      },
    ]);
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "child-settled-response", reason: "end_turn" } },
      `child-settled-${randomUUID()}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("a web-UI submission's gate card stays off the channel (TKAI-323)", async () => {
    // With the web turn's text muted on the channel, its approval card would
    // be a live button with zero context. The card belongs where the
    // submission runs: the web UI.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      webUserEntry({ sessionId: session.id, threadId, queueItemId: "qi-webgate-1" }),
    ]);

    const gate: DecisionGate = {
      id: `gate-${randomUUID()}`,
      sessionId: session.id,
      threadId,
      queueItemId: "qi-webgate-1",
      resumeKey: "rk-webgate-1",
      ordinal: 1,
      type: "approval",
      title: "Approve the thing?",
      body: "do the thing",
      actions: [{ id: "approve", label: "Approve", style: "primary" }],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "decision_gate", threadId, gate } },
      `webgate-${randomUUID()}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.gatePrompts).toHaveLength(0);
  });

  it.each([
    { behavior: "suppresses auto-post after a successful explicit reply", ok: true, expected: [] },
    { behavior: "falls back to auto-post after a failed explicit reply", ok: false, expected: ["internal copy of explicit reply"] },
  ])("$behavior in production event order", async ({ ok, expected }) => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const assistantEntry: SessionEntry = {
      type: "message",
      id: "explicit-result",
      sessionId: session.id,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      role: "assistant",
      content: "internal copy of explicit reply",
      queueItemId: "qi-explicit",
      parts: [{
        type: "tool_call",
        callId: "tc-explicit",
        toolName: "call_tool",
        status: "running",
        args: { tool_id: "slack.reply_to_origin", params: { text: "explicit reply" } },
      }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId: "qi-explicit",
        signal: {
          signalType: "fake.message",
          tagName: "signal",
          origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" },
        },
      }),
      assistantEntry,
    ]);

    const messageEnd = {
      sessionId: session.id,
      threadId,
      queueItemId: "qi-explicit",
      timestamp: Date.now(),
      event: { type: "message_end" as const, threadId, messageId: "explicit-result", reason: "end_turn" as const },
    };
    await eventStream.append(messageEnd, `explicit-message-${ok}-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);

    const part = assistantEntry.type === "message" ? assistantEntry.parts?.[0] : undefined;
    if (!part || part.type !== "tool_call") throw new Error("missing reply tool call");
    part.status = "completed";
    part.result = {
      content: [{ type: "text", text: ok ? "sent" : "failed" }],
      details: { ok },
      text: ok ? "sent" : "failed",
    };
    await engineStore.updateEntry(session.id, threadId, assistantEntry);
    const toolEnd = {
      sessionId: session.id,
      threadId,
      queueItemId: "qi-explicit",
      timestamp: Date.now(),
      event: {
        type: "tool_end" as const,
        threadId,
        tool: "call_tool",
        callId: "tc-explicit",
        result: ok ? "sent" : "failed",
        isError: false,
      },
    };
    await eventStream.append(toolEnd, `explicit-tool-${ok}-${randomUUID()}`);
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(expected));

    await eventStream.append(messageEnd, `explicit-message-redelivery-${ok}-${randomUUID()}`);
    await eventStream.append(toolEnd, `explicit-tool-redelivery-${ok}-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(expected);
  });

  it.each([
    { kind: "designated final", params: { text: "Detailed final result", final: true }, expected: ["I am checking"] },
    { kind: "text-less legacy progress", params: { text: "Progress update" }, expected: ["I am checking", "Done."] },
  ])("handles a $kind reply before a different terminal wrap-up", async ({ params, expected }) => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const call: SessionEntry = {
      type: "message", id: "bare-success", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "", queueItemId: "qi-bare-success",
      parts: [{ type: "tool_call", callId: "tc-bare-success", toolName: "call_tool", status: "running", args: { tool_id: "slack.reply_to_origin", params } }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } } }),
      {
        type: "message", id: "bare-success-ack", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "I am checking", queueItemId: "qi-bare-success",
      },
    ]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-success-ack", reason: "end_turn" } }, `bare-success-ack-${randomUUID()}`);
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["I am checking"]));
    // The engine stores tool-use messages without stopReason, then appends a
    // separate terminal wrap-up after the reply action completes.
    await engineStore.appendEntries(session.id, threadId, [call]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-success", reason: "tool_use" } }, `bare-success-message-${randomUUID()}`);
    const part = call.type === "message" ? call.parts?.[0] : undefined;
    if (!part || part.type !== "tool_call") throw new Error("missing reply call");
    part.status = "completed";
    part.result = { details: { ok: true }, text: "sent" };
    await engineStore.updateEntry(session.id, threadId, call);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "tool_end", threadId, tool: "call_tool", callId: part.callId, result: "sent", isError: false } }, `bare-success-tool-${randomUUID()}`);
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "bare-success-wrap", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "Done.", queueItemId: "qi-bare-success", stopReason: "end_turn",
    }]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-success-wrap", reason: "end_turn" } }, `bare-success-wrap-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(expected);
  });

  it("defers later text while an earlier text-less origin reply is pending", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({ sessionId: session.id, threadId, queueItemId: "qi-bare-pending", signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } } }),
      {
        type: "message", id: "bare-pending", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "", queueItemId: "qi-bare-pending",
        parts: [{ type: "tool_call", callId: "tc-bare-pending", toolName: "call_tool", status: "running", args: { tool_id: "slack.reply_to_origin" } }],
      },
      {
        type: "message", id: "bare-pending-wrap", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now() + 1, role: "assistant", content: "internal wrap-up", queueItemId: "qi-bare-pending",
      },
    ]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-pending", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-pending-wrap", reason: "end_turn" } }, `bare-pending-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("waits for a running retry, falls back after all failures, and deduplicates redelivery", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const retry: SessionEntry = {
      type: "message", id: "running-retry", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now() + 1, role: "assistant", content: "original first text", queueItemId: "qi-retry",
      parts: [{ type: "tool_call", callId: "tc-retry", toolName: "call_tool", status: "running", args: { tool_id: "slack.reply_to_origin" } }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({ sessionId: session.id, threadId, queueItemId: "qi-retry", signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } } }),
      {
        type: "message", id: "failed-call", sessionId: session.id, threadId, parentId: null,
        createdAt: Date.now(), role: "assistant", content: "", queueItemId: "qi-retry",
        parts: [{ type: "tool_call", callId: "tc-failed", toolName: "call_tool", status: "completed", args: { tool_id: "slack.reply_to_origin" }, result: { details: { ok: false }, text: "failed" } }],
      },
      retry,
    ]);
    const messageEnd = { sessionId: session.id, threadId, queueItemId: "qi-retry", timestamp: Date.now(), event: { type: "message_end" as const, threadId, messageId: "running-retry", reason: "end_turn" as const } };
    await eventStream.append(messageEnd, `retry-message-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);

    const retryPart = retry.type === "message" ? retry.parts?.[0] : undefined;
    if (!retryPart || retryPart.type !== "tool_call") throw new Error("missing retry call");
    retryPart.status = "completed";
    retryPart.result = { details: { ok: false }, text: "failed again" };
    await engineStore.updateEntry(session.id, threadId, retry);
    const toolEnd = { sessionId: session.id, threadId, queueItemId: "qi-retry", timestamp: Date.now(), event: { type: "tool_end" as const, threadId, tool: "call_tool", callId: retryPart.callId, result: "failed again", isError: false } };
    await eventStream.append(toolEnd, `retry-tool-${randomUUID()}`);
    await vi.waitFor(() => expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["original first text"]));

    await eventStream.append(messageEnd, `retry-message-redelivery-${randomUUID()}`);
    await eventStream.append(toolEnd, `retry-tool-redelivery-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((sent) => sent.message.markdown)).toEqual(["original first text"]);
  });

  it("does not post failed origin-reply fallback after the submission aborts", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItem: QueueItem = {
      id: "qi-aborted-reply", threadId, content: "prompt", status: "queued", attemptCount: 0,
      maxAttempts: 10, timeoutAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await engineStore.admitSubmission(session.id, threadId, queueItem);
    const reply: SessionEntry = {
      type: "message", id: "aborted-reply", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "stale first text", queueItemId: queueItem.id,
      parts: [{ type: "tool_call", callId: "tc-aborted", toolName: "call_tool", status: "running", args: { tool_id: "slack.reply_to_origin" } }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({ sessionId: session.id, threadId, queueItemId: queueItem.id, signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } } }),
      reply,
    ]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: queueItem.id, timestamp: Date.now(), event: { type: "message_end", threadId, messageId: reply.id, reason: "end_turn" } }, `aborted-message-${randomUUID()}`);
    await engineStore.settleUnclaimed(session.id, threadId, queueItem.id, { outcome: "aborted" });
    const part = reply.type === "message" ? reply.parts?.[0] : undefined;
    if (!part || part.type !== "tool_call") throw new Error("missing aborted call");
    part.status = "completed";
    part.result = { details: { ok: false }, text: "failed" };
    await engineStore.updateEntry(session.id, threadId, reply);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: queueItem.id, timestamp: Date.now(), event: { type: "tool_end", threadId, tool: "call_tool", callId: part.callId, result: "failed", isError: false } }, `aborted-tool-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await engineStore.getQueueItem(session.id, queueItem.id))?.outcome).toEqual({ outcome: "aborted" });
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("posts tool-use narration before its decision gate", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const queueItemId = "qi-tool-use-gate";
    const gate: DecisionGate = {
      id: "gate-tool-use",
      sessionId: session.id,
      threadId,
      queueItemId,
      resumeKey: "rk-tool-use",
      ordinal: 0,
      type: "approval",
      title: "Approve the thing?",
      actions: [{ id: "approve", label: "Approve", style: "primary" }],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({
        sessionId: session.id,
        threadId,
        queueItemId,
        signal: {
          signalType: "fake.message",
          tagName: "signal",
          origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" },
        },
      }),
      {
        type: "message",
        id: "tool-use-narration",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "I need approval before I continue.",
        queueItemId,
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        queueItemId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "tool-use-narration", reason: "tool_use" },
      },
      `tool-use-narration-${randomUUID()}`,
    );
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "decision_gate", threadId, gate } },
      `tool-use-gate-${randomUUID()}`,
    );

    await vi.waitFor(() => expect(fakeTransport.gatePrompts).toHaveLength(1));
    expect(fakeTransport.deliveries).toEqual([
      { type: "message", markdown: "I need approval before I continue." },
      { type: "gate", gateId: gate.id },
    ]);
  });

  it("gate on a channel thread → sendGatePrompt; resolution → edit", async () => {
    // A named user row makes the resolution label an audit fact ("by …").
    await testDb.appDb
      .insert(users)
      .values({ id: USER_ID, name: "Test Resolver", email: "resolver@example.com" })
      .onConflictDoNothing();
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;

    const gate: DecisionGate = {
      id: `gate-${randomUUID()}`,
      sessionId: session.id,
      threadId,
      queueItemId: "qi-1",
      resumeKey: "rk-1",
      ordinal: 1,
      type: "approval",
      title: "Approve the thing?",
      body: 'do the thing\n\ntool_id=fake.do_thing\nargs={"target":"prod"}',
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      context: {
        riskLevel: "high",
        service: "fake",
        tool_id: "fake.do_thing",
        args: { target: "prod" },
        summary: "do the thing",
      },
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "decision_gate", threadId, gate } },
      `gate-open-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gatePrompts).toHaveLength(1);
    });
    expect(fakeTransport.gatePrompts[0]?.prompt).toMatchObject({ gateId: gate.id, title: gate.title });

    // The card is digested: summary body plus labeled fields, no raw JSON dump.
    const sentPrompt = fakeTransport.gatePrompts[0]?.prompt;
    expect(sentPrompt?.body).toContain("do the thing");
    expect(sentPrompt?.body).not.toContain("args=");
    expect(sentPrompt?.fields).toEqual([
      { label: "Tool", value: "`fake.do_thing`" },
      { label: "Risk", value: "high" },
      { label: "target", value: "prod" },
    ]);

    const ref = fakeTransport.gatePrompts[0]
      ? { conversationKey: fakeTransport.gatePrompts[0].conversationKey, messageId: fakeTransport.gatePrompts[0].messageId }
      : null;
    expect(ref).not.toBeNull();
    if (ref) {
      const mapped = host.gateForRef(ref);
      expect(mapped).toMatchObject({ gateId: gate.id, sessionId: session.id });
    }

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: {
          type: "decision_gate_resolved",
          threadId,
          gateId: gate.id,
          resolution: { actionId: "approve", resolvedBy: USER_ID, resolvedAt: Date.now() },
        },
      },
      `gate-resolve-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain("✅");
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain("Approve");
    // The edit names the resolver and carries the timestamp, so the settled
    // message can show who decided and when.
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain("by Test Resolver");
    expect(fakeTransport.gateEdits[0]?.resolution.resolvedAtMs).toBeTypeOf("number");

    // All three gate maps must be cleared after the edit.
    expect(ref ? host.gateForRef(ref) : null).toBeNull();
  });

  /**
   * Opens one approval gate on a channel-bound thread and waits for its card.
   * Returns the gate, the thread it lives on, and the card's prompt ref.
   */
  async function openChannelGate(): Promise<{ sessionId: string; threadId: string; gateId: string; ref: GatePromptRef }> {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: {
          type: "decision_gate",
          threadId,
          gate: {
            id: gateId,
            sessionId: session.id,
            threadId,
            queueItemId: `qi-${gateId}`,
            resumeKey: `rk-${gateId}`,
            ordinal: 1,
            type: "approval",
            title: "Approve the thing?",
            actions: [
              { id: "approve", label: "Approve", style: "primary" },
              { id: "deny", label: "Deny", style: "danger" },
            ],
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      },
      `gate-open-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.gatePrompts).toHaveLength(1);
    });
    const prompt = fakeTransport.gatePrompts[0];
    return {
      sessionId: session.id,
      threadId,
      gateId,
      ref: { conversationKey: prompt?.conversationKey ?? "", messageId: prompt?.messageId ?? "" },
    };
  }

  /** The three gate maps are private, and a leak is only visible in them.
   * Element access reads them with their real types, so the assertion needs
   * no cast and still breaks if a map's shape changes. */
  function gateMapSizes(target: ChannelHost): { refs: number; prompts: number; actions: number } {
    return {
      refs: target["gateRefs"].size,
      prompts: target["gatePrompts"].size,
      actions: target["gateActions"].size,
    };
  }

  it("a withdrawn gate clears its card instead of leaving live buttons", async () => {
    const { sessionId, threadId, gateId, ref } = await openChannelGate();
    expect(host.gateForRef(ref)).toMatchObject({ gateId });

    await eventStream.append(
      {
        sessionId,
        threadId,
        timestamp: Date.now(),
        event: { type: "decision_gate_withdrawn", threadId, gateId, reason: "abort" },
      },
      `gate-withdraw-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain(
      "Withdrawn: the run was stopped. Start it again in Valet if you still need it.",
    );
    expect(fakeTransport.gateEdits[0]?.ref).toEqual(ref);
    // Nothing may still map the card to the gate, and no map may keep a row.
    expect(host.gateForRef(ref)).toBeNull();
    expect(gateMapSizes(host)).toEqual({ refs: 0, prompts: 0, actions: 0 });
  });

  it("an expired gate clears its card instead of leaving live buttons", async () => {
    const { sessionId, threadId, gateId, ref } = await openChannelGate();

    await eventStream.append(
      {
        sessionId,
        threadId,
        timestamp: Date.now(),
        event: { type: "decision_gate_expired", threadId, gateId },
      },
      `gate-expire-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain(
      "Expired: no one answered in time. Start the run again in Valet.",
    );
    expect(host.gateForRef(ref)).toBeNull();
    expect(gateMapSizes(host)).toEqual({ refs: 0, prompts: 0, actions: 0 });
  });

  it("gate_callback round trip resolves the real gate", async () => {

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "fake.do_thing", params: {}, summary: "do the thing" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("acknowledged"),
    ]);

    await host.handleUpdate("fake", inbound({ dispatchId: `fake:${randomUUID()}`, text: "do the risky thing" }));

    await vi.waitFor(
      () => {
        expect(fakeTransport.gatePrompts).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    const promptRef = {
      conversationKey: fakeTransport.gatePrompts[0]?.conversationKey ?? "",
      messageId: fakeTransport.gatePrompts[0]?.messageId ?? "",
    };
    const mapped = host.gateForRef(promptRef);
    expect(mapped).not.toBeNull();
    const gateId = mapped?.gateId;
    expect(gateId).toBeTruthy();

    // `pendingDecisionGates` lists every gate row for the session regardless
    // of status; assert on the gate's own status field, not presence.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    expect((await session.pendingDecisionGates()).find((g) => g.id === gateId)?.status).toBe("pending");

    await host.handleUpdate(
      "fake",
      inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId: "cb1", ref: promptRef },
      }),
    );

    await vi.waitFor(
      async () => {
        const pending = await session.pendingDecisionGates();
        expect(pending.find((g) => g.id === gateId)?.status).toBe("resolved");
      },
      { timeout: 3000 },
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });
    expect(fakeTransport.gateEdits[0]?.resolution.label).toContain("✅");
    expect(fakeTransport.answered.some((a) => a.callbackId === "cb1")).toBe(true);
  });

  it("attention-DM prompt resolves a gate on a NON-channel thread", async () => {
    // The gate is raised on a web thread — no channel thread, so no
    // channel-thread card. The attention DM's prompt is the only handle.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "fake.do_thing", params: {}, summary: "do the thing" }, { id: "tc2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("acknowledged"),
    ]);
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const thread = session.thread("web:default");
    await thread.submitPrompt({ text: "do the risky thing" }, { dispatchId: `web:${randomUUID()}` });

    let gateId = "";
    await vi.waitFor(
      async () => {
        const pending = (await session.pendingDecisionGates()).filter((g) => g.status === "pending");
        expect(pending).toHaveLength(1);
        gateId = pending[0]?.id ?? "";
      },
      { timeout: 3000 },
    );
    expect(fakeTransport.gatePrompts).toHaveLength(0);

    const gate = (await session.pendingDecisionGates()).find((g) => g.id === gateId);
    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      sessionId: session.id,
      title: gate?.title ?? "",
      body: gate?.body,
      gate: { id: gateId, actions: gate?.actions ?? [] },
    });
    expect(fakeTransport.gatePrompts).toHaveLength(1);

    const promptRef = {
      conversationKey: fakeTransport.gatePrompts[0]?.conversationKey ?? "",
      messageId: fakeTransport.gatePrompts[0]?.messageId ?? "",
    };
    await host.handleUpdate(
      "fake",
      inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId: "cb2", ref: promptRef },
      }),
    );

    await vi.waitFor(
      async () => {
        const pending = await session.pendingDecisionGates();
        expect(pending.find((g) => g.id === gateId)?.status).toBe("resolved");
      },
      { timeout: 3000 },
    );
    expect(fakeTransport.answered.some((a) => a.callbackId === "cb2" && a.text === undefined)).toBe(true);
  });

  it("a Slack approval resolves its originating workflow gate", async () => {
    const now = Date.now();
    await testDb.appDb.insert(workflowDefinitions).values({
      id: "workflow-slack-gate",
      orgId: ORG_ID,
      ownerType: "user",
      ownerId: USER_ID,
      name: "Slack gate",
      definition: {},
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      "workflow-slack-run",
      { workflowId: "workflow-slack-gate", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      { ownerType: "user", ownerId: USER_ID },
    );
    const sessionId = "wf:workflow-slack-run:step";
    const session = await ensureWorkflowSession({
      host: engineHost,
      store: workflowStore,
      db: testDb.appDb,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    }, sessionId);
    const threadId = session.thread().id;
    await engineStore.saveDecisionGate(sessionId, threadId, {
      id: "workflow-slack-approval",
      sessionId,
      threadId,
      queueItemId: "q-workflow",
      resumeKey: "workflow-action",
      ordinal: 0,
      type: "approval",
      title: "Approve workflow action?",
      actions: [{ id: "approve", label: "Approve", style: "primary" }],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      sessionId,
      title: "Approve workflow action?",
      gate: { id: "workflow-slack-approval", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
    });
    const prompt = fakeTransport.gatePrompts[0];
    expect(prompt).toBeDefined();
    const ref = { conversationKey: prompt?.conversationKey ?? "", messageId: prompt?.messageId ?? "" };

    await host.handleUpdate("fake", inbound({
      dispatchId: `fake:${randomUUID()}`,
      kind: "gate_callback",
      gateCallback: { actionId: "forged_approve", callbackId: "forged-workflow-callback", ref },
    }));
    expect((await engineStore.getDecisionGate(sessionId, "workflow-slack-approval"))?.status).toBe("pending");
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "forged-workflow-callback")?.text).toContain("already resolved");

    await host.handleUpdate("fake", inbound({
      dispatchId: `fake:${randomUUID()}`,
      kind: "gate_callback",
      gateCallback: {
        actionId: "approve", callbackId: "unmapped-workflow-callback", gateId: "workflow-slack-approval",
        ref: { conversationKey: ref.conversationKey, messageId: "forged-message" },
      },
    }));
    expect((await engineStore.getDecisionGate(sessionId, "workflow-slack-approval"))?.status).toBe("pending");
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "unmapped-workflow-callback")?.text).toContain("expired");

    const restoreFailure = vi.spyOn(engineHost, "workflowSessionFor").mockRejectedValueOnce(new Error("restore failed"));
    await host.handleUpdate("fake", inbound({
      dispatchId: `fake:${randomUUID()}`,
      kind: "gate_callback",
      gateCallback: { actionId: "approve", callbackId: "failed-workflow-callback", ref },
    }));
    restoreFailure.mockRestore();
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "failed-workflow-callback")?.text).toContain("Open the session");
    expect((await engineStore.getDecisionGate(sessionId, "workflow-slack-approval"))?.status).toBe("pending");

    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      sessionId,
      title: "Approve workflow action?",
      gate: { id: "workflow-slack-approval", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
    });
    const secondPrompt = fakeTransport.gatePrompts[1];
    expect(secondPrompt).toBeDefined();
    const secondRef = { conversationKey: secondPrompt?.conversationKey ?? "", messageId: secondPrompt?.messageId ?? "" };

    await Promise.all(["workflow-callback-a", "workflow-callback-b"].map((callbackId, index) =>
      host.handleUpdate("fake", inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId, ref: index === 0 ? ref : secondRef },
      })),
    ));

    await vi.waitFor(async () => {
      expect((await engineStore.getDecisionGate(sessionId, "workflow-slack-approval"))?.status).toBe("resolved");
    });
    expect((await engineStore.getDecisionGate(sessionId, "workflow-slack-approval"))?.resolution).toMatchObject({
      actionId: "approve",
      resolvedBy: USER_ID,
    });
    expect(fakeTransport.answered.filter((answer) => answer.callbackId.startsWith("workflow-callback") && answer.text === undefined)).toHaveLength(1);
    expect(fakeTransport.answered.filter((answer) => answer.callbackId.startsWith("workflow-callback") && answer.text?.includes("already resolved"))).toHaveLength(1);
  });

  it("rejects a cross-org workflow callback with the uniform expired response", async () => {
    const { ref } = await seedWorkflowGate({
      workflowId: "workflow-cross-org",
      runId: "workflow-cross-org-run",
      workflowOrgId: "other-org",
      owner: { ownerType: "user", ownerId: USER_ID },
      gateId: "cross-org-gate",
    });

    await callback(ref, "cross-org-callback");

    expect(fakeTransport.answered.find((answer) => answer.callbackId === "cross-org-callback")?.text).toContain("expired");
  });

  it("rejects cross-org workflow callbacks even after a session row is backfilled", async () => {
    const { ref, sessionId } = await seedWorkflowGate({
      workflowId: "workflow-cross-org-backfilled",
      runId: "workflow-cross-org-backfilled-run",
      workflowOrgId: "other-org",
      owner: { ownerType: "user", ownerId: USER_ID },
      gateId: "cross-org-backfilled-gate",
    });
    await testDb.appDb.insert(agentSessions).values({
      id: sessionId, orgId: "other-org", userId: USER_ID,
      ownerType: "user", ownerId: USER_ID,
      title: "Workflow", workspace: "test", status: "active", createdAt: 1, updatedAt: 1,
    });
    await callback(ref, "cross-org-backfilled-callback");
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "cross-org-backfilled-callback")?.text).toContain("expired");
    expect((await engineStore.getDecisionGate(sessionId, "cross-org-backfilled-gate"))?.status).toBe("pending");
  });

  it.each([false, true])("rejects an org-owned workflow callback from a non-admin (backfilled: %s)", async (backfilled) => {
    const { ref, sessionId } = await seedWorkflowGate({
      workflowId: "workflow-org-owned",
      runId: "workflow-org-owned-run",
      workflowOrgId: ORG_ID,
      owner: { ownerType: "org", ownerId: ORG_ID },
      gateId: "org-owned-gate",
    });

    if (backfilled) await testDb.appDb.insert(agentSessions).values({
      id: sessionId, orgId: ORG_ID, userId: USER_ID,
      ownerType: "org", ownerId: ORG_ID,
      title: "Workflow", workspace: "test", status: "active", createdAt: 1, updatedAt: 1,
    });
    await callback(ref, "org-owned-callback");

    expect(fakeTransport.answered.find((answer) => answer.callbackId === "org-owned-callback")?.text).toContain("expired");
    expect((await engineStore.getDecisionGate(sessionId, "org-owned-gate"))?.status).toBe("pending");
  });

  it("rejects a team-owned workflow callback from a non-member", async () => {
    await testDb.appDb.insert(teams).values({ id: "workflow-team", orgId: ORG_ID, name: "Workflow team", createdAt: 1 });
    const { ref, sessionId } = await seedWorkflowGate({
      workflowId: "workflow-team-owned",
      runId: "workflow-team-owned-run",
      workflowOrgId: ORG_ID,
      owner: { ownerType: "team", ownerId: "workflow-team" },
      gateId: "team-owned-gate",
    });

    await callback(ref, "team-owned-callback");

    expect(fakeTransport.answered.find((answer) => answer.callbackId === "team-owned-callback")?.text).toContain("expired");
    expect((await engineStore.getDecisionGate(sessionId, "team-owned-gate"))?.status).toBe("pending");
  });

  it("lets an org admin resolve an org-owned workflow always_allow action", async () => {
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG_ID, userId: USER_ID, role: "admin", createdAt: Date.now() });
    const { ref, sessionId } = await seedWorkflowGate({
      workflowId: "workflow-admin-owned",
      runId: "workflow-admin-owned-run",
      workflowOrgId: ORG_ID,
      owner: { ownerType: "org", ownerId: ORG_ID },
      gateId: "admin-always-allow-gate",
      actions: [{ id: "always_allow", label: "Always allow", style: "primary" }],
    });

    await callback(ref, "admin-always-allow-callback", "always_allow");

    expect((await engineStore.getDecisionGate(sessionId, "admin-always-allow-gate"))?.status).toBe("resolved");
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "admin-always-allow-callback" && answer.text === undefined)).toBeDefined();
  });

  it("delivers the plain summary when a workflow gate authorization fails", async () => {
    const { sessionId } = await seedWorkflowGate({
      workflowId: "workflow-attention-error",
      runId: "run-attention-error",
      workflowOrgId: ORG_ID,
      owner: { ownerType: "user", ownerId: USER_ID },
      gateId: "gate-attention-error",
    });
    // The authorization read fails the way a database blip fails it.
    vi.spyOn(workflowStore, "getRun").mockRejectedValue(new Error("workflow store unavailable"));

    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      sessionId,
      title: "Approve workflow action?",
      body: "the run is waiting",
      gate: { id: "gate-attention-error", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
    });

    // A failed authorization may cost the buttons. It must not cost the DM.
    expect(fakeTransport.gatePrompts).toHaveLength(0);
    expect(fakeTransport.sent).toHaveLength(1);
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Approve workflow action?");
  });

  it("delivers the plain summary when the session lookup for a gate DM fails", async () => {
    await testDb.appDb.insert(agentSessions).values({
      id: "sess-attention-read",
      userId: USER_ID,
      orgId: ORG_ID,
      workspace: "w",
      ownerType: "user",
      ownerId: USER_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Put the `agent_sessions` table out of reach for the length of the
    // delivery, the way a database fault puts it out of reach. Every other
    // read the DM needs keeps working, so the session lookup is the only one
    // that fails. The table is restored before any other test runs.
    await testDb.pgdb.query("ALTER TABLE agent_sessions RENAME TO agent_sessions_unreachable");
    try {
      await host.attentionDeliverer().deliver(USER_ID, {
        kind: "approval",
        owner: { type: "user", id: USER_ID },
        sessionId: "sess-attention-read",
        title: "Approve the thing?",
        body: "the run is waiting",
        gate: { id: "gate-attention-read", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
      });
    } finally {
      await testDb.pgdb.query("ALTER TABLE agent_sessions_unreachable RENAME TO agent_sessions");
    }

    expect(fakeTransport.gatePrompts).toHaveLength(0);
    expect(fakeTransport.sent).toHaveLength(1);
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Approve the thing?");
  });

  it("authorizes a workflow gate DM without building the workflow session", async () => {
    const { sessionId } = await seedWorkflowGate({
      workflowId: "workflow-attention-cheap",
      runId: "run-attention-cheap",
      workflowOrgId: ORG_ID,
      owner: { ownerType: "user", ownerId: USER_ID },
      gateId: "gate-attention-cheap",
    });
    // Seeding already built the session. Only a build by the DELIVERER counts.
    const build = vi.spyOn(engineHost, "workflowSessionFor");

    await host.attentionDeliverer().deliver(USER_ID, {
      kind: "approval",
      owner: { type: "user", id: USER_ID },
      sessionId,
      title: "Approve workflow action?",
      gate: { id: "gate-attention-cheap", actions: [{ id: "approve", label: "Approve", style: "primary" }] },
    });

    expect(fakeTransport.gatePrompts).toHaveLength(1);
    // Asking whether a recipient MAY resolve a gate reads rows. It must not
    // materialize a session per recipient per transport.
    expect(build).not.toHaveBeenCalled();
  });

  it("gate_callback from a user who may not resolve the session answers 'expired'", async () => {
    await testDb.appDb.insert(agentSessions).values({
      id: "sess-not-yours",
      userId: "someone-else",
      orgId: ORG_ID,
      workspace: "w",
      ownerType: "user",
      ownerId: "someone-else",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const ref = { conversationKey: "fake:dm:77", messageId: "m-denied" };
    host.recordGatePrompt("gate-denied", ref, "sess-not-yours");

    await host.handleUpdate(
      "fake",
      inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId: "cb3", ref },
      }),
    );

    const answer = fakeTransport.answered.find((a) => a.callbackId === "cb3");
    expect(answer?.text).toContain("expired");
  });

  it("a click on a session with no row drop-logs unauthorized, not a workflow reason", async () => {
    // An ordinary session id whose row is gone (deleted, or never written).
    // Nothing about it is a workflow, so the drop reason must not say so.
    const ref = { conversationKey: "fake:dm:77", messageId: "m-ghost" };
    host.recordGatePrompt("gate-ghost", ref, "sess-ghost");

    await host.handleUpdate(
      "fake",
      inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "approve", callbackId: "cb-ghost", ref },
      }),
    );

    const drops = await testDb.appDb.select().from(eventDropLog);
    const reasons = drops.map((row) => row.reason);
    expect(reasons).toContain("unauthorized");
    expect(reasons).not.toContain("workflow_session_malformed");
    expect(drops.find((row) => row.reason === "unauthorized")?.detail).toBe(
      "sender may not resolve this session's gates",
    );
    // The clicker still gets the uniform answer, so a probe learns nothing.
    expect(fakeTransport.answered.find((answer) => answer.callbackId === "cb-ghost")?.text).toContain("expired");
  });

  it("gate_callback with always_allow from a non-org-admin answers with the admin requirement", async () => {
    await testDb.appDb.insert(agentSessions).values({
      id: "sess-own",
      userId: USER_ID,
      orgId: ORG_ID,
      workspace: "w",
      ownerType: "user",
      ownerId: USER_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const ref = { conversationKey: "fake:dm:77", messageId: "m-always" };
    host.recordGatePrompt("gate-always", ref, "sess-own");

    await host.handleUpdate(
      "fake",
      inbound({
        dispatchId: `fake:${randomUUID()}`,
        kind: "gate_callback",
        gateCallback: { actionId: "always_allow", callbackId: "cb4", ref },
      }),
    );

    const answer = fakeTransport.answered.find((a) => a.callbackId === "cb4");
    expect(answer?.text).toContain("org admin");
  });
});

describe("ChannelHost.attentionDeliverer", () => {
  let testDb: TestPgDb;
  let host: ChannelHost;
  let fakeTransport: FakeTransport;
  let eventStream: PgEventStream;

  async function buildHost(overrides: Partial<ChannelHostDeps> = {}): Promise<ChannelHost> {
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;

    const engineStore = new PgSessionStore(pgdb);
    const sandboxProvider = new VirtualSandboxProvider();
    eventStream = new PgEventStream(pgdb);
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

    const engineHost = new EngineHost({
      engineStore,
      sandboxProvider,
      eventStream,
      engineCredentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
    });

    const built = new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials,
      plugins: [fakePlugin],
      resolveOrgId: async () => ORG_ID,
      ...overrides,
    });
    await built.start();
    return built;
  }

  afterEach(async () => {
    host?.stopOutbound();
  });

  function event(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
    return {
      kind: "notification",
      owner: { type: "user", id: USER_ID },
      title: "Stuck submission",
      ...overrides,
    };
  }

  it("sends one DM to a linked user with notifyAttention enabled", async () => {
    host = await buildHost();
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    await host.attentionDeliverer().deliver(USER_ID, event({ body: "details here" }));

    expect(fakeTransport.sent).toHaveLength(1);
    expect(fakeTransport.sent[0]?.conversationKey).toBe("fake:dm:77");
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Stuck submission");
    expect(fakeTransport.sent[0]?.message.markdown).toContain("details here");
  });

  it("does not send when the linked user disabled notifyAttention", async () => {
    host = await buildHost();
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await setNotifyAttention(testDb.appDb, "fake", USER_ID, false);

    await host.attentionDeliverer().deliver(USER_ID, event());

    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("does not send when the user has no linked identity", async () => {
    host = await buildHost();

    await host.attentionDeliverer().deliver(USER_ID, event());

    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("includes an 'Open in Valet' link when href is present and publicUrl is set", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    await host.attentionDeliverer().deliver(USER_ID, event({ href: "/sessions/abc" }));

    expect(fakeTransport.sent[0]?.message.markdown).toContain(
      "[Open in Valet](https://valet.example.com/sessions/abc)",
    );
  });

  it("omits the link line when href is present but publicUrl is unset", async () => {
    host = await buildHost();
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    await host.attentionDeliverer().deliver(USER_ID, event({ href: "/sessions/abc" }));

    expect(fakeTransport.sent[0]?.message.markdown).not.toContain("Open in Valet");
  });

  /** The eligibility gate reads the session's app row, so deliverer tests
   * that expect buttons must seed one the recipient may resolve. */
  async function seedUserSession(id: string, ownerId = USER_ID): Promise<void> {
    await testDb.appDb.insert(agentSessions).values({
      id,
      userId: ownerId,
      orgId: ORG_ID,
      workspace: "w",
      ownerType: "user",
      ownerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it("approval event with a gate sends a real prompt: buttons, link in the body, ref recorded", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await seedUserSession("sess-1");

    await host.attentionDeliverer().deliver(
      USER_ID,
      event({
        kind: "approval",
        sessionId: "sess-1",
        title: "Approve the thing?",
        body: "please confirm",
        href: "/sessions/sess-1",
        gate: {
          id: "gate-1",
          actions: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
        },
      }),
    );

    // The DM is a gate prompt, not a plain summary message.
    expect(fakeTransport.sent).toHaveLength(0);
    expect(fakeTransport.gatePrompts).toHaveLength(1);
    const prompt = fakeTransport.gatePrompts[0];
    expect(prompt?.prompt.gateId).toBe("gate-1");
    expect(prompt?.prompt.title).toBe("Approve the thing?");
    expect(prompt?.prompt.actions.map((a) => a.id)).toEqual(["approve", "deny"]);
    expect(prompt?.prompt.body).toContain("please confirm");
    expect(prompt?.prompt.body).toContain("[Open in Valet](https://valet.example.com/sessions/sess-1)");

    // The ref is recorded, so the inbound gate_callback path can find it.
    const ref = { conversationKey: prompt?.conversationKey ?? "", messageId: prompt?.messageId ?? "" };
    expect(host.gateForRef(ref)).toMatchObject({ gateId: "gate-1", sessionId: "sess-1" });
  });

  it("an approval event without a gate keeps a branded plain summary message", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await testDb.appDb.insert(assistants).values({
      id: "asst-attention",
      orgId: ORG_ID,
      ownerType: "user",
      ownerId: USER_ID,
      name: "Ledger",
      avatarUrl: "https://cdn.example.com/ledger.png",
      sessionId: "sess-1",
      isDefault: false,
      createdAt: Date.now(),
    });

    await host.attentionDeliverer().deliver(
      USER_ID,
      event({ kind: "approval", sessionId: "sess-1", href: "/sessions/sess-1" }),
    );

    expect(fakeTransport.gatePrompts).toHaveLength(0);
    expect(fakeTransport.sent).toHaveLength(1);
    expect(fakeTransport.sent[0]?.message.sender).toEqual({
      displayName: "Ledger",
      avatarUrl: "https://cdn.example.com/ledger.png",
    });
  });

  it("resolution edits EVERY recorded prompt for the gate — one message per recipient DM", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "88", userId: "second-user" });

    // A team-owned session, so BOTH recipients pass the eligibility gate.
    await testDb.appDb.insert(teams).values({ id: "team-appr", orgId: ORG_ID, name: "Approvers", createdAt: 1 });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-appr", userId: USER_ID, role: "member" });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-appr", userId: "second-user", role: "member" });
    await testDb.appDb.insert(agentSessions).values({
      id: "sess-1",
      userId: USER_ID,
      orgId: ORG_ID,
      workspace: "w",
      ownerType: "team",
      ownerId: "team-appr",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const approval = event({
      kind: "approval",
      sessionId: "sess-1",
      gate: { id: "gate-multi", actions: [{ id: "approve", label: "Approve" }] },
    });
    await host.attentionDeliverer().deliver(USER_ID, approval);
    await host.attentionDeliverer().deliver("second-user", approval);
    expect(fakeTransport.gatePrompts).toHaveLength(2);

    await eventStream.append(
      {
        sessionId: "sess-1",
        threadId: "t-1",
        timestamp: Date.now(),
        event: {
          type: "decision_gate_resolved",
          threadId: "t-1",
          gateId: "gate-multi",
          resolution: { actionId: "approve", resolvedBy: USER_ID, resolvedAt: Date.now() },
        },
      },
      `gate-multi-resolve-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(2);
    });
    const editedIds = fakeTransport.gateEdits.map((e) => `${e.ref.conversationKey}#${e.ref.messageId}`).sort();
    const promptIds = fakeTransport.gatePrompts.map((p) => `${p.conversationKey}#${p.messageId}`).sort();
    expect(editedIds).toEqual(promptIds);

    // Every ref is cleared after the edit.
    for (const p of fakeTransport.gatePrompts) {
      expect(host.gateForRef({ conversationKey: p.conversationKey, messageId: p.messageId })).toBeNull();
    }
  });

  it("a recipient who may not resolve the gate gets the plain summary, not dead buttons", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await seedUserSession("sess-foreign", "someone-else");

    await host.attentionDeliverer().deliver(
      USER_ID,
      event({
        kind: "approval",
        sessionId: "sess-foreign",
        href: "/sessions/sess-foreign",
        gate: {
          id: "gate-foreign",
          actions: [{ id: "approve", label: "Approve" }],
          fields: [{ label: "Tool", value: "`fake.do_thing`" }],
        },
      }),
    );

    expect(fakeTransport.gatePrompts).toHaveLength(0);
    expect(fakeTransport.sent).toHaveLength(1);
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Open in Valet");
    // The plain summary still names WHAT was requested — the digested body
    // alone no longer carries the tool id.
    expect(fakeTransport.sent[0]?.message.markdown).toContain("**Tool:** `fake.do_thing`");
  });

  it("a prompt recorded AFTER its gate settled is edited immediately, not left with live buttons", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
    await seedUserSession("sess-race");

    // The gate settles before the DM prompt lands — routeAttention fires
    // deliverers without awaiting them, so this ordering is legitimate.
    await eventStream.append(
      {
        sessionId: "sess-race",
        threadId: "t-1",
        timestamp: Date.now(),
        event: {
          type: "decision_gate_resolved",
          threadId: "t-1",
          gateId: "gate-race",
          resolution: { actionId: "approve", resolvedBy: USER_ID, resolvedAt: Date.now() },
        },
      },
      `race-${randomUUID()}`,
    );
    // No refs exist yet, so the resolved event changes nothing observable;
    // give the subscription a beat to record the settled resolution.
    await new Promise((r) => setTimeout(r, 300));

    await host.attentionDeliverer().deliver(
      USER_ID,
      event({
        kind: "approval",
        sessionId: "sess-race",
        gate: { id: "gate-race", actions: [{ id: "approve", label: "Approve" }] },
      }),
    );

    expect(fakeTransport.gatePrompts).toHaveLength(1);
    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });
    const p = fakeTransport.gatePrompts[0];
    expect(host.gateForRef({ conversationKey: p?.conversationKey ?? "", messageId: p?.messageId ?? "" })).toBeNull();
  });
});
