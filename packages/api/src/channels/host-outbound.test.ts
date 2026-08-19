import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
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
  readonly channelType = "fake";
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
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create: () => fakeTransport }],
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
          ],
        },
      ],
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

  it("skips mid-turn assistant messages (message_end fires per-message, not just at turn end)", async () => {
    // message_end fires with reason "end_turn" for every non-abort assistant
    // message the engine persists, including mid-turn narration before a
    // tool call — only the turn's genuine final message persists
    // stopReason "end_turn" on the entry itself. A mid-turn entry (no
    // stopReason) paired with a message_end("end_turn") event must not be
    // delivered.
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
        content: "Let me check.",
        // No stopReason: this is a mid-turn narration message, not the
        // turn's final one.
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

    // Give the (would-be, buggy) delivery a real window to happen before
    // asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fakeTransport.sent.some((s) => s.message.markdown.includes("Let me check."))).toBe(false);
  });

  it("gate on a channel thread → sendGatePrompt; resolution → edit", async () => {
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
      body: "please confirm",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
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
});

describe("ChannelHost.attentionDeliverer", () => {
  let testDb: TestPgDb;
  let host: ChannelHost;
  let fakeTransport: FakeTransport;

  async function buildHost(overrides: Partial<ChannelHostDeps> = {}): Promise<ChannelHost> {
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
});
