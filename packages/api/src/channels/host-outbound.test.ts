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
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { agentSessions, teamMembers, teams, users } from "../schema/index.js";
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

  it("delivers a completed assistant message on a channel-keyed thread", async () => {
    faux.setResponses([fauxAssistantMessage("orchestrator says hi")]);

    await host.handleUpdate("fake", inbound({ dispatchId: `fake:${randomUUID()}` }));

    await vi.waitFor(
      () => {
        expect(fakeTransport.sent.some((s) => s.message.markdown.includes("orchestrator says hi"))).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("ignores message_end on non-channel threads", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const thread = session.thread("web:default");
    faux.setResponses([fauxAssistantMessage("web only reply")]);
    await thread.submitPrompt({ text: "hi" }, { dispatchId: `web:${randomUUID()}` });

    // Give the turn time to complete; no send should ever land on fakeTransport.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("does not deliver the same messageId twice", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "dup-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "duplicate delivery test",
        stopReason: "end_turn",
      },
    ]);

    const event: BusEvent = {
      sessionId: session.id,
      threadId,
      timestamp: Date.now(),
      event: { type: "message_end", threadId, messageId: "dup-msg-1", reason: "end_turn" },
    };
    await eventStream.append(event, `dup-1-${randomUUID()}`);
    await eventStream.append(event, `dup-2-${randomUUID()}`);

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("duplicate delivery test"))).toBe(true);
    });
    // Give a second pass an opportunity to double-deliver before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fakeTransport.sent.filter((s) => s.message.markdown.includes("duplicate delivery test"))).toHaveLength(1);
  });

  it("delivers a command_result to the channel the command came from", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
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

  it("delivers a mid-turn assistant message that carries text", async () => {
    // A model can put its whole reply in the same message as its first tool
    // call (persisted stopReason undefined) and end the turn on an empty
    // message. Gating delivery on stopReason "end_turn" drops that reply,
    // so mid-turn messages with text must deliver.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "mid-turn-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "Hi Carly — noting that down.",
        // No stopReason: this message stopped on a tool call, mid-turn.
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "mid-turn-msg-1", reason: "end_turn" },
      },
      `mid-turn-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Hi Carly"))).toBe(true);
    });
  });

  it("skips an assistant message with no text and no attachments", async () => {
    // The empty turn-final message that follows a reply-then-tool-calls turn
    // must not produce an empty channel message.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "empty-final-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "",
        stopReason: "end_turn",
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "empty-final-msg-1", reason: "end_turn" },
      },
      `empty-final-${randomUUID()}`,
    );

    // Give the (would-be, buggy) delivery a real window to happen before
    // asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("delivers the reply from a text+tool-call message when the turn ends on an empty message", async () => {
    // Regression: the whole reply rides in the same message as the first
    // tool call (stopReason toolUse → persisted undefined), then the turn
    // ends with an empty message (persisted stopReason "end_turn"). The
    // reply must reach the channel exactly once.
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Hi Carly — I'm the team's assistant."),
          fauxToolCall("call_tool", { tool_id: "fake.lookup", params: {}, summary: "look something up" }, { id: "tc-mid" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(""),
    ]);

    await host.handleUpdate("fake", inbound({ dispatchId: `fake:${randomUUID()}`, text: "introduce yourself" }));

    await vi.waitFor(
      () => {
        expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Hi Carly"))).toBe(true);
      },
      { timeout: 3000 },
    );
    // Let the turn settle, then assert the reply landed exactly once and the
    // empty final message produced nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.filter((s) => s.message.markdown.includes("Hi Carly"))).toHaveLength(1);
    expect(fakeTransport.sent.filter((s) => s.message.markdown.trim() === "")).toHaveLength(0);
  });

  it("posts a mid-turn text message before the gate card its tool call raised", async () => {
    // deliverAssistantMessage and deliverGatePrompt each await transport
    // calls. Without per-thread serialization in startOutbound, the gate
    // card (fast send) can land before the slower text send that preceded
    // it. The artificial send delay makes that race deterministic.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "order-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "About to ask for approval.",
      },
    ]);
    fakeTransport.sendDelayMs = 100;

    const gate: DecisionGate = {
      id: `gate-${randomUUID()}`,
      sessionId: session.id,
      threadId,
      queueItemId: "qi-order-1",
      resumeKey: "rk-order-1",
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
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "order-msg-1", reason: "end_turn" },
      },
      `order-msg-${randomUUID()}`,
    );
    await eventStream.append(
      { sessionId: session.id, threadId, timestamp: Date.now(), event: { type: "decision_gate", threadId, gate } },
      `order-gate-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.gatePrompts).toHaveLength(1);
    });
    // The text must already be on the channel when the card lands.
    expect(fakeTransport.sent.some((s) => s.message.markdown.includes("About to ask for approval."))).toBe(true);
  });

  it("routes a mid-turn message on the events thread to its submission's origin", async () => {
    // The "events" thread key does not decode to a channel; delivery must
    // resolve the submission's origin and rebuild the conversationKey
    // through the transport — for a MID-TURN message, not just a turn-final
    // one.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "origin-user-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user",
        content: "who are you",
        queueItemId: "qi-origin-1",
        signal: {
          signalType: "keyed.app_mention",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100" },
        },
      },
      {
        type: "message",
        id: "origin-mid-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "routed by origin",
        queueItemId: "qi-origin-1",
        // No stopReason: mid-turn.
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "origin-mid-1", reason: "end_turn" },
      },
      `origin-mid-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(keyedTransport.sent).toEqual([
        { conversationKey: "keyed:R1:D100", message: { markdown: "routed by origin" } },
      ]);
    });
  });

  it("keeps an overheard submission's mid-turn text off the channel (reply manual)", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "manual-user-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user",
        content: "a passing remark",
        queueItemId: "qi-manual-1",
        signal: {
          signalType: "keyed.message",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual" },
        },
      },
      {
        type: "message",
        id: "manual-mid-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "thinking out loud",
        queueItemId: "qi-manual-1",
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "manual-mid-1", reason: "end_turn" },
      },
      `manual-mid-${randomUUID()}`,
    );

    // Give the (would-be, buggy) delivery a real window before asserting
    // its absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(keyedTransport.sent).toHaveLength(0);
  });

  it("overheard final with no origin action gets ONE reply-dropped note per thread (TKAI-284)", async () => {
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    const overheardTurn = (n: number) => [
      {
        type: "message" as const,
        id: `od-user-${n}`,
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user" as const,
        content: "a passing remark",
        queueItemId: `qi-od-${n}`,
        signal: {
          signalType: "keyed.message",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual" as const },
        },
      },
      {
        type: "message" as const,
        id: `od-final-${n}`,
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant" as const,
        content: "here is my answer to that remark",
        queueItemId: `qi-od-${n}`,
        stopReason: "end_turn" as const,
      },
    ];
    await engineStore.appendEntries(session.id, threadId, overheardTurn(1));
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "od-final-1", reason: "end_turn" },
      },
      `od-final-1-${randomUUID()}`,
    );

    const feedbackEntries = async () => {
      const entries = await engineStore.getEntries(session.id, threadId);
      return entries.filter(
        (e) => e.type === "message" && e.role === "user" && e.signal?.signalType === "channel.reply_dropped",
      );
    };
    await vi.waitFor(async () => {
      const found = await feedbackEntries();
      expect(found).toHaveLength(1);
      expect((found[0] as { content?: string }).content).toContain("NOT posted");
      expect(found[0].type === "message" && found[0].signal?.origin?.reply).toBe("manual");
    });
    // Nothing auto-posted: the note is a signal to the agent, not a channel send.
    expect(keyedTransport.sent).toHaveLength(0);

    // A second swallowed overheard final on the SAME thread: the durable
    // dispatchId dedup keeps it at one note.
    await engineStore.appendEntries(session.id, threadId, overheardTurn(2));
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "od-final-2", reason: "end_turn" },
      },
      `od-final-2-${randomUUID()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await feedbackEntries()).toHaveLength(1);
  });

  it("a turn that acted on its origin, and a feedback-triggered turn, get no reply-dropped note", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      // Turn A: overheard, but the agent posted via send_message (not the
      // origin actions) — it still acted, so the swallowed wrap-up is
      // expected and gets no note.
      {
        type: "message",
        id: "acted-user-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user",
        content: "a remark",
        queueItemId: "qi-acted-1",
        signal: {
          signalType: "keyed.message",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual" },
        },
      },
      {
        type: "message",
        id: "acted-mid-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "replying properly",
        queueItemId: "qi-acted-1",
        parts: [
          {
            type: "tool_call",
            callId: "tc-1",
            toolName: "call_tool",
            status: "completed",
            args: { tool_id: "keyed.send_message", params: { text: "hi" } },
            result: { details: { ok: true } },
          },
        ],
      },
      {
        type: "message",
        id: "acted-final-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "done, replied in thread",
        queueItemId: "qi-acted-1",
        stopReason: "end_turn",
      },
      // Turn B: the prompt IS a feedback note — the loop guard stands down.
      {
        type: "message",
        id: "fb-user-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user",
        content: "your reply was not posted",
        queueItemId: "qi-fb-1",
        signal: {
          signalType: "channel.reply_dropped",
          tagName: "signal",
          attributes: { feedback: "reply_dropped" },
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "manual" },
        },
      },
      {
        type: "message",
        id: "fb-final-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "understood, staying silent",
        queueItemId: "qi-fb-1",
        stopReason: "end_turn",
      },
    ]);
    for (const messageId of ["acted-final-1", "fb-final-1"]) {
      await eventStream.append(
        {
          sessionId: session.id,
          threadId,
          timestamp: Date.now(),
          event: { type: "message_end", threadId, messageId, reason: "end_turn" },
        },
        `${messageId}-${randomUUID()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const entries = await engineStore.getEntries(session.id, threadId);
    const notes = entries.filter(
      (e) => e.type === "message" && e.role === "user" && e.signal?.attributes?.feedback !== undefined,
    );
    // Only the hand-written fb-user-1 — the host generated no new note.
    expect(notes.map((e) => e.id)).toEqual(["fb-user-1"]);
  });

  it("a failed addressed auto-post feeds the error back to the agent (TKAI-284)", async () => {
    faux.setResponses([fauxAssistantMessage("(noted)")]);
    vi.spyOn(keyedTransport, "send").mockRejectedValue(new Error("channel_archived"));
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("events").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "fail-user-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "user",
        content: "who are you",
        queueItemId: "qi-fail-1",
        signal: {
          signalType: "keyed.app_mention",
          tagName: "signal",
          origin: { channelType: "keyed", threadKey: "keyed:D100", reply: "auto" },
        },
      },
      {
        type: "message",
        id: "fail-final-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "I am the assistant",
        queueItemId: "qi-fail-1",
        stopReason: "end_turn",
      },
    ]);
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "fail-final-1", reason: "end_turn" },
      },
      `fail-final-${randomUUID()}`,
    );
    await vi.waitFor(async () => {
      const entries = await engineStore.getEntries(session.id, threadId);
      const note = entries.find(
        (e) => e.type === "message" && e.role === "user" && e.signal?.signalType === "channel.reply_dropped",
      );
      expect(note).toBeDefined();
      expect((note as { content?: string }).content).toContain("channel_archived");
      expect((note as { content?: string }).content).toContain("reply_to_origin");
    });
  });

  it("auto-posts only the first text-bearing message of a submission", async () => {
    // One auto-post per turn: the first message is the reply, later text
    // rounds are working notes. A new submission gets its own slot.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const base = {
      type: "message" as const,
      sessionId: session.id,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      role: "assistant" as const,
    };
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "turn1-msg-1", content: "I'll dig into the v1 implementation first.", queueItemId: "qi-turn-1" },
      { ...base, id: "turn1-msg-2", content: "Let me look at the repo directly.", queueItemId: "qi-turn-1" },
      { ...base, id: "turn2-msg-1", content: "Second turn reply.", queueItemId: "qi-turn-2" },
    ]);

    for (const messageId of ["turn1-msg-1", "turn1-msg-2", "turn2-msg-1"]) {
      await eventStream.append(
        {
          sessionId: session.id,
          threadId,
          timestamp: Date.now(),
          event: { type: "message_end", threadId, messageId, reason: "end_turn" },
        },
        `first-only-${messageId}-${randomUUID()}`,
      );
    }

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Second turn reply."))).toBe(true);
    });
    // Deliveries are serialized per thread, so once the last message landed
    // the earlier ones have settled: turn 1 posted exactly its first text.
    expect(fakeTransport.sent.map((s) => s.message.markdown)).toEqual([
      "I'll dig into the v1 implementation first.",
      "Second turn reply.",
    ]);
  });

  it("posts the ack AND the turn-final answer; the narration between stays off the channel", async () => {
    // The field failure this pins: the model acks, works for 14 rounds, and
    // ends the turn on the real answer. The reader must get the ack and the
    // answer with no model cooperation — not just the ack.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const base = {
      type: "message" as const,
      sessionId: session.id,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      role: "assistant" as const,
      queueItemId: "qi-ackfinal-1",
    };
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "af-msg-1", content: "I'll check the code for how the key flows." },
      { ...base, id: "af-msg-2", content: "Found the single injection point. Reading it fully." },
      { ...base, id: "af-msg-3", content: "No. The key never enters the sandbox.", stopReason: "end_turn" },
    ]);

    for (const messageId of ["af-msg-1", "af-msg-2", "af-msg-3"]) {
      await eventStream.append(
        {
          sessionId: session.id,
          threadId,
          timestamp: Date.now(),
          event: { type: "message_end", threadId, messageId, reason: "end_turn" },
        },
        `ackfinal-${messageId}-${randomUUID()}`,
      );
    }

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("never enters the sandbox"))).toBe(true);
    });
    expect(fakeTransport.sent.map((s) => s.message.markdown)).toEqual([
      "I'll check the code for how the key flows.",
      "No. The key never enters the sandbox.",
    ]);
  });

  it("does NOT auto-post the final message when the agent replied via reply_to_origin mid-turn", async () => {
    // The agent stays in control: an explicit successful reply IS the
    // result, so the mechanical final-message post stands down. Only the
    // ack (posted before the action ran) reaches the thread from the
    // safety net.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const base = {
      type: "message" as const,
      sessionId: session.id,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      role: "assistant" as const,
      queueItemId: "qi-explicit-1",
    };
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "ex-msg-1", content: "On it — checking now." },
    ]);
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "ex-msg-1", reason: "end_turn" },
      },
      `explicit-ack-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("On it"))).toBe(true);
    });

    // Mid-turn: the agent replies explicitly (successful call persisted),
    // then ends the turn with a wrap-up message.
    await engineStore.appendEntries(session.id, threadId, [
      {
        ...base,
        id: "ex-msg-2",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc-explicit-reply",
            toolName: "call_tool",
            status: "completed",
            args: { tool_id: "slack.reply_to_origin", params: { text: "Here is the formatted answer." } },
            result: { text: "ok", details: { ok: true } },
          },
        ],
      },
      { ...base, id: "ex-msg-3", content: "Wrapping up my notes.", stopReason: "end_turn" },
    ]);
    for (const messageId of ["ex-msg-2", "ex-msg-3"]) {
      await eventStream.append(
        {
          sessionId: session.id,
          threadId,
          timestamp: Date.now(),
          event: { type: "message_end", threadId, messageId, reason: "end_turn" },
        },
        `explicit-${messageId}-${randomUUID()}`,
      );
    }

    // The final message must NOT post — the explicit reply already did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.map((s) => s.message.markdown)).toEqual(["On it — checking now."]);
  });

  it("stands down when the submission already replied through reply_to_origin", async () => {
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "acted-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "Replied in the thread.",
        queueItemId: "qi-acted-1",
        parts: [
          { type: "text", text: "Replied in the thread." },
          {
            type: "tool_call",
            callId: "tc-reply-1",
            toolName: "call_tool",
            status: "completed",
            args: { tool_id: "slack.reply_to_origin", params: { text: "explicit reply" } },
            // The engine stamps details.ok from the action's success flag.
            result: { text: "ok", details: { ok: true } },
          },
        ],
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "acted-msg-1", reason: "end_turn" },
      },
      `acted-${randomUUID()}`,
    );

    // The explicit reply IS the turn's reply; the auto-post must not add a
    // second copy. Absence check needs a real window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent).toHaveLength(0);
  });

  it("does NOT stand down for a FAILED reply_to_origin — the safety net still posts", async () => {
    // An action failure persists with part.status "completed" (the model
    // reads the corrective text) but details.ok false. Treating it as "the
    // turn replied" would leave the thread with nothing at all.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    await engineStore.appendEntries(session.id, threadId, [
      {
        type: "message",
        id: "failed-reply-msg-1",
        sessionId: session.id,
        threadId,
        parentId: null,
        createdAt: Date.now(),
        role: "assistant",
        content: "The reply the reader must still get.",
        queueItemId: "qi-failed-reply-1",
        parts: [
          { type: "text", text: "The reply the reader must still get." },
          {
            type: "tool_call",
            callId: "tc-reply-fail",
            toolName: "call_tool",
            status: "completed",
            args: { tool_id: "slack.reply_to_origin", params: { text: "never sent" } },
            result: { text: "slack.reply_to_origin failed: no token", details: { ok: false } },
          },
        ],
      },
    ]);

    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "failed-reply-msg-1", reason: "end_turn" },
      },
      `failed-reply-${randomUUID()}`,
    );

    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("must still get"))).toBe(true);
    });
  });

  it("a resolved gate re-opens the submission's auto-post slot for the outcome", async () => {
    // Pre-gate segment posts its first message; the reader approves; the
    // post-approval outcome must reach that reader, not stay off-channel.
    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, { type: "user", id: USER_ID }, { actorUserId: USER_ID, orgId: ORG_ID });
    const threadId = session.thread("fake:99").id;
    const base = {
      type: "message" as const,
      sessionId: session.id,
      threadId,
      parentId: null,
      createdAt: Date.now(),
      role: "assistant" as const,
    };
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "seg1-msg-1", content: "About to do the risky thing.", queueItemId: "qi-gated-1" },
    ]);
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "seg1-msg-1", reason: "end_turn" },
      },
      `seg1-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("About to do"))).toBe(true);
    });

    const gate: DecisionGate = {
      id: `gate-${randomUUID()}`,
      sessionId: session.id,
      threadId,
      queueItemId: "qi-gated-1",
      resumeKey: "rk-seg-1",
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
      `seg-gate-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.gatePrompts).toHaveLength(1);
    });
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
      `seg-resolve-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.gateEdits).toHaveLength(1);
    });

    // The post-approval segment's first message posts.
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "seg2-msg-1", content: "Done: the thing succeeded.", queueItemId: "qi-gated-1" },
    ]);
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "seg2-msg-1", reason: "end_turn" },
      },
      `seg2-${randomUUID()}`,
    );
    await vi.waitFor(() => {
      expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Done: the thing succeeded."))).toBe(true);
    });
    // The re-opened slot is consumed: a THIRD text message stays off-channel.
    await engineStore.appendEntries(session.id, threadId, [
      { ...base, id: "seg2-msg-2", content: "Cleaning up quietly.", queueItemId: "qi-gated-1" },
    ]);
    await eventStream.append(
      {
        sessionId: session.id,
        threadId,
        timestamp: Date.now(),
        event: { type: "message_end", threadId, messageId: "seg2-msg-2", reason: "end_turn" },
      },
      `seg2b-${randomUUID()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Cleaning up"))).toBe(false);
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

  it("an approval event without a gate keeps the plain summary message", async () => {
    host = await buildHost({ publicUrl: "https://valet.example.com" });
    await linkIdentity(testDb.appDb, { provider: "fake", externalId: "77", userId: USER_ID });

    await host.attentionDeliverer().deliver(
      USER_ID,
      event({ kind: "approval", sessionId: "sess-1", href: "/sessions/sess-1" }),
    );

    expect(fakeTransport.gatePrompts).toHaveLength(0);
    expect(fakeTransport.sent).toHaveLength(1);
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
