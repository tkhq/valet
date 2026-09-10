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
import { agentSessions, assistants, teamMembers, teams, users } from "../schema/index.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import type { AttentionEvent } from "../orchestrator/attention.js";
import { linkIdentity, setNotifyAttention } from "./identity-links.js";
import { ChannelHost, type ChannelHostDeps } from "./host.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";

class FakeTransport implements ChannelTransport {
  readonly channelType: string = "fake";
  /** Artificial latency on send(), to make delivery-order races observable. */
  sendDelayMs = 0;
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
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
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: String(this.nextMessageId++) };
  }
  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment) {
    this.media.push({ conversationKey, attachment });
    return { conversationKey, messageId: String(this.nextMessageId++) };
  }
  async sendGatePrompt(conversationKey: string, prompt: ChannelGatePrompt) {
    const messageId = String(this.nextMessageId++);
    this.gatePrompts.push({ conversationKey, prompt, messageId });
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
    const engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));

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

    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });
  });

  afterEach(async () => {
    host.stopOutbound();
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

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

  it("posts only the first addressed response and keeps the final result internal", async () => {
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

    await vi.waitFor(() => expect(keyedTransport.sent).toHaveLength(1));
    expect(keyedTransport.sent[0]?.message.markdown).toBe("I am on it");
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

  it("lets a successful text-less origin reply own later wrap-up text", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const call: SessionEntry = {
      type: "message", id: "bare-success", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "", queueItemId: "qi-bare-success",
      parts: [{ type: "tool_call", callId: "tc-bare-success", toolName: "call_tool", status: "running", args: { tool_id: "slack.reply_to_origin" } }],
    };
    await engineStore.appendEntries(session.id, threadId, [
      userEntry({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", signal: { signalType: "fake.message", tagName: "signal", origin: { channelType: "fake", threadKey: "fake:99", reply: "auto" } } }),
      call,
    ]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-success", reason: "end_turn" } }, `bare-success-message-${randomUUID()}`);
    const part = call.type === "message" ? call.parts?.[0] : undefined;
    if (!part || part.type !== "tool_call") throw new Error("missing reply call");
    part.status = "completed";
    part.result = { details: { ok: true }, text: "sent" };
    await engineStore.updateEntry(session.id, threadId, call);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "tool_end", threadId, tool: "call_tool", callId: part.callId, result: "sent", isError: false } }, `bare-success-tool-${randomUUID()}`);
    await engineStore.appendEntries(session.id, threadId, [{
      type: "message", id: "bare-success-wrap", sessionId: session.id, threadId, parentId: null,
      createdAt: Date.now(), role: "assistant", content: "internal wrap-up", queueItemId: "qi-bare-success", stopReason: "end_turn",
    }]);
    await eventStream.append({ sessionId: session.id, threadId, queueItemId: "qi-bare-success", timestamp: Date.now(), event: { type: "message_end", threadId, messageId: "bare-success-wrap", reason: "end_turn" } }, `bare-success-wrap-${randomUUID()}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
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
