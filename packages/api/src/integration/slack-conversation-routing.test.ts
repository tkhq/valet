import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { ChannelTransport, InboundChannelEvent, OutboundChannelMessage, ValetPlugin } from "@valet/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChannelHost } from "../channels/host.js";
import { linkIdentity } from "../channels/identity-links.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const FIRST = { userId: "local-user", externalId: "U001", channelId: "D001" };
const SECOND = { userId: "test-member", externalId: "U002", channelId: "D002" };
type Identity = typeof FIRST;

const homeSchema = z.object({ sessionId: z.string(), threadId: z.string() });
const threadSchema = z.object({ id: z.string(), sessionId: z.string(), key: z.string().optional(), title: z.string().optional() }).passthrough();
const threadsSchema = z.object({ threads: z.array(threadSchema) });
const historySchema = z.object({
  hasMore: z.boolean(),
  messages: z.array(z.object({
    id: z.string(), sessionId: z.string(), threadId: z.string().nullable(), role: z.string(), content: z.string(),
    completed: z.boolean().optional(), channelType: z.string().optional(),
    signal: z.object({ signalType: z.string() }).passthrough().optional(),
    author: z.object({ id: z.string(), interactive: z.boolean().optional() }).passthrough().optional(),
  }).passthrough()),
});
type HomeAddress = z.infer<typeof homeSchema>;
type ListedThread = z.infer<typeof threadSchema>;
type History = z.infer<typeof historySchema>["messages"];

// Only the transport and model are fake. Routing, storage, auth, and REST run normally.
function fakeSlackTransport() {
  return {
    channelType: "slack",
    verifyWebhook: () => null,
    parseUpdate: () => null,
    threadKeyFromConversationKey: (key: string) => {
      const [, , channel, root] = key.split(":");
      return `slack:${channel}:${root}`;
    },
    conversationKeyFromThreadKey: (key: string) => `slack:T001:${key.slice("slack:".length)}`,
    send: vi.fn(async (conversationKey: string, _message: OutboundChannelMessage) => ({ conversationKey, messageId: "fixture-reply" })),
    sendMedia: async (conversationKey: string) => ({ conversationKey, messageId: "fixture-media" }),
    sendGatePrompt: async (conversationKey: string) => ({ conversationKey, messageId: "fixture-gate" }),
    updateGatePrompt: async () => {},
  } satisfies ChannelTransport;
}

describe("api integration: Slack DM conversation routing", () => {
  let api: TestApi;
  let faux: FauxProviderRegistration;
  let slack: ReturnType<typeof fakeSlackTransport>;
  let host: ChannelHost;
  let plugin: ValetPlugin;
  let homes: Map<string, HomeAddress>;
  let serial: number;

  async function request(user: Identity, path: string, body?: unknown): Promise<Response> {
    return fetch(`${api.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": user.userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function messages(user: Identity, threadId: string): Promise<History> {
    const response = await request(user, `/api/threads/${encodeURIComponent(threadId)}/messages`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = historySchema.parse(await response.json());
    expect(body.hasMore).toBe(false);
    return body.messages;
  }

  async function threads(user: Identity, query = ""): Promise<ListedThread[]> {
    const response = await request(user, `/api/sessions/${encodeURIComponent(home(user).sessionId)}/threads${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = threadsSchema.parse(await response.json());
    return body.threads;
  }

  function home(user: Identity): HomeAddress {
    const value = homes.get(user.userId);
    if (!value) throw new Error("Expected a Home opened through REST");
    return value;
  }

  function inbound(user: Identity, root: string, text: string, overrides: Partial<InboundChannelEvent> = {}): InboundChannelEvent {
    return {
      dispatchId: `slack:fixture-${++serial}`,
      conversationKey: `slack:T001:${user.channelId}:${root}`,
      sender: { externalId: user.externalId, displayName: "Fixture member" },
      kind: "message",
      text,
      raw: {},
      ...overrides,
    };
  }

  async function waitForReply(user: Identity, threadId: string, reply: string): Promise<History> {
    let history: History = [];
    await vi.waitFor(async () => {
      history = await messages(user, threadId);
      expect(history.some(message => message.role === "assistant" && message.completed && message.content === reply)).toBe(true);
    }, { timeout: 10_000 });
    return history;
  }

  async function webPrompt(user: Identity, threadId: string, text: string, reply: string): Promise<History> {
    faux.appendResponses([fauxAssistantMessage(reply)]);
    const response = await request(user, `/api/threads/${encodeURIComponent(threadId)}/messages`, { text });
    expect(response.status, await response.clone().text()).toBe(202);
    return waitForReply(user, threadId, reply);
  }

  async function slackPrompt(user: Identity, root: string, text: string, reply: string): Promise<ListedThread> {
    faux.appendResponses([fauxAssistantMessage(reply)]);
    await host.handleUpdate("slack", inbound(user, root, text), true);
    const listed = await threads(user);
    const thread = listed.find(item => item.key === `slack:${user.channelId}:${root}`);
    if (!thread) throw new Error(`Slack root ${root} did not appear in the REST thread list`);
    await waitForReply(user, thread.id, reply);
    await vi.waitFor(() => expect(slack.send.mock.calls).toContainEqual([
      `slack:T001:${user.channelId}:${root}`, expect.objectContaining({ markdown: expect.stringContaining(reply) }),
    ]), { timeout: 10_000 });
    return thread;
  }

  beforeEach(async () => {
    serial = 0;
    homes = new Map();
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error(`Unexpected external request in routing test: ${url.origin}`);
      }
      return realFetch(input, init);
    });
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    slack = fakeSlackTransport();
    plugin = { name: "slack-routing-fixture", version: "0", transports: [{ channelType: "slack", create: () => slack }] };
    api = await bootTestApi({ plugins: [plugin] });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token", accessToken: "fixture-bot-token",
    });
    host = api.providers.channelHost;
    await host.start();
    for (const user of [FIRST, SECOND]) {
      await linkIdentity(api.providers.db, { provider: "slack", externalId: user.externalId, userId: user.userId });
      const response = await request(user, "/api/home", {});
      expect(response.status, await response.clone().text()).toBe(200);
      const opened = homeSchema.parse(await response.json());
      homes.set(user.userId, opened);
      await webPrompt(user, opened.threadId, `${user.userId} saved Home content`, `${user.userId} Home reply`);
    }
  });

  afterEach(async () => {
    try {
      await host?.stop();
      await api?.cleanup();
    } finally {
      faux?.unregister();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it("opens each new DM root as a separate private chat reachable by both REST addresses", async () => {
    const allIds = new Set<string>();
    for (const user of [FIRST, SECOND]) {
      const originalHome = await messages(user, home(user).threadId);
      const firstRoot = await slackPrompt(user, "111.1", `${user.userId} first DM`, `${user.userId} first DM reply`);
      const newRoot = await slackPrompt(user, "222.2", `${user.userId} new DM`, `${user.userId} new DM reply`);
      expect(new Set([home(user).threadId, firstRoot.id, newRoot.id]).size).toBe(3);
      for (const thread of [firstRoot, newRoot]) {
        allIds.add(thread.id);
        const addressResponse = await request(user, `/api/threads/${thread.id}`);
        expect(addressResponse.status).toBe(200);
        const address = await addressResponse.json();
        expect(address).toMatchObject({ id: thread.id, sessionId: home(user).sessionId });
        const history = await messages(user, thread.id);
        expect(history.every(message => message.threadId === thread.id && message.sessionId === thread.sessionId)).toBe(true);
        expect(history.find(message => message.role === "user")).toMatchObject({
          channelType: "slack", signal: { signalType: "slack.message", origin: { channelType: "slack" } },
          author: { id: user.userId },
        });
        const sessionHistory = await request(user,
          `/api/sessions/${encodeURIComponent(thread.sessionId)}/messages?threadId=${encodeURIComponent(thread.id)}`);
        expect(sessionHistory.status).toBe(200);
        const body = historySchema.parse(await sessionHistory.json());
        expect(body.messages).toEqual(history);
      }
      expect((await messages(user, firstRoot.id)).map(message => message.content)).toEqual([
        `${user.userId} first DM`, `${user.userId} first DM reply`,
      ]);
      expect((await messages(user, newRoot.id)).map(message => message.content)).toEqual([
        `${user.userId} new DM`, `${user.userId} new DM reply`,
      ]);
      expect(await messages(user, home(user).threadId)).toEqual(originalHome);
      const fixed = await threads(user, `?fixedOnly=1&fixedId=${encodeURIComponent(home(user).threadId)}`);
      expect(fixed.map(thread => thread.id)).toEqual([home(user).threadId]);
      expect(fixed[0]).toMatchObject({ title: "Home", sessionId: home(user).sessionId });
      const other = user === FIRST ? SECOND : FIRST;
      for (const threadId of [home(user).threadId, firstRoot.id, newRoot.id]) {
        expect((await request(other, `/api/threads/${threadId}/messages`)).status).toBe(404);
        expect((await request(other, `/api/threads/${threadId}`)).status).toBe(404);
        expect((await request(other,
          `/api/sessions/${encodeURIComponent(home(user).sessionId)}/messages?threadId=${encodeURIComponent(threadId)}`)).status).toBe(404);
      }
      expect((await request(other, `/api/sessions/${encodeURIComponent(home(user).sessionId)}/threads`)).status).toBe(404);
    }
    expect(allIds.size).toBe(4);
    expect(home(FIRST).threadId).not.toBe(home(SECOND).threadId);
  });

  it("keeps replies and repeated edits in the original DM while other REST histories stay unchanged", async () => {
    const first = await slackPrompt(FIRST, "111.1", "First root original", "First root answer");
    const second = await slackPrompt(FIRST, "222.2", "Second root original", "Second root answer");
    const other = await slackPrompt(SECOND, "111.1", "Other identity original", "Other identity answer");
    const untouched = await Promise.all([
      messages(FIRST, home(FIRST).threadId), messages(FIRST, second.id), messages(SECOND, other.id),
    ]);
    const listedBefore = (await threads(FIRST)).map(thread => thread.id).sort();
    for (const [previousText, text] of [["First root original", "First root correction"], ["First root correction", "First root final"]]) {
      await host.handleUpdate("slack", inbound(FIRST, "111.1", text, { kind: "edit", previousText }), true);
      await vi.waitFor(async () => {
        const history = await messages(FIRST, first.id);
        expect(history.some(message => message.signal?.signalType === "slack.message_changed"
          && message.content.includes(`Before: ${previousText}\nAfter: ${text}`))).toBe(true);
      }, { timeout: 10_000 });
    }
    const reply = await slackPrompt(FIRST, "111.1", "Reply under first root", "Answer under first root");
    expect(reply.id).toBe(first.id);
    const history = await messages(FIRST, first.id);
    expect(history.filter(message => message.signal?.signalType === "slack.message_changed")).toHaveLength(2);
    expect(history.filter(message => message.role === "assistant").map(message => message.content)).toEqual([
      "First root answer", "Answer under first root",
    ]);
    expect(history.filter(message => message.signal?.signalType === "slack.message").map(message => message.content)).toEqual([
      "First root original", "Reply under first root",
    ]);
    expect(await Promise.all([
      messages(FIRST, home(FIRST).threadId), messages(FIRST, second.id), messages(SECOND, other.id),
    ])).toEqual(untouched);
    expect((await threads(FIRST)).map(thread => thread.id).sort()).toEqual(listedBefore);
    // The later Slack reply is a barrier for this thread's serialized outbound work.
    expect(slack.send.mock.calls.map(([key, message]) => [key, message.markdown])).toEqual([
      ["slack:T001:D001:111.1", "First root answer"],
      ["slack:T001:D001:222.2", "Second root answer"],
      ["slack:T001:D002:111.1", "Other identity answer"],
      ["slack:T001:D001:111.1", "Answer under first root"],
    ]);
  });

  it("keeps a web follow-up web-origin without posting it to the bound Slack conversation", async () => {
    const thread = await slackPrompt(FIRST, "111.1", "Slack request", "Slack answer");
    const homeBefore = await messages(FIRST, home(FIRST).threadId);
    const history = await webPrompt(FIRST, thread.id, "Web follow-up", "Web-only answer");
    const webMessage = history.find(message => message.content === "Web follow-up");
    expect(webMessage).toMatchObject({ threadId: thread.id, role: "user", author: { id: FIRST.userId, interactive: true } });
    expect(webMessage?.signal).toBeUndefined();
    expect(webMessage?.channelType).toBeUndefined();
    const after = await slackPrompt(FIRST, "111.1", "Slack follow-up", "Next Slack answer");
    expect(after.id).toBe(thread.id);
    expect(slack.send.mock.calls.map(([key, message]) => [key, message.markdown])).toEqual([
      ["slack:T001:D001:111.1", "Slack answer"],
      ["slack:T001:D001:111.1", "Next Slack answer"],
    ]);
    expect((await messages(FIRST, thread.id)).map(message => message.content)).toEqual([
      "Slack request", "Slack answer", "Web follow-up", "Web-only answer", "Slack follow-up", "Next Slack answer",
    ]);
    expect(await messages(FIRST, home(FIRST).threadId)).toEqual(homeBefore);
  });

  it("preserves a legacy Home route and a separate DM route after engine eviction and a fresh channel host", async () => {
    const savedHome = home(FIRST);
    // This saved signal models history written before separate DM routing existed.
    await api.providers.engineStore.appendEntries(savedHome.sessionId, savedHome.threadId, [{
      id: "fixture-legacy-slack", sessionId: savedHome.sessionId, threadId: savedHome.threadId,
      parentId: null, type: "message", role: "user", content: "Saved legacy DM content", createdAt: Date.now(),
      signal: { signalType: "slack.message", tagName: "slack", origin: { channelType: "slack", threadKey: "slack:D001:099.9" } },
    }]);
    faux.appendResponses([fauxAssistantMessage("Legacy Home answer")]);
    await host.handleUpdate("slack", inbound(FIRST, "099.9", "Legacy root follow-up"), true);
    await waitForReply(FIRST, savedHome.threadId, "Legacy Home answer");
    await vi.waitFor(() => expect(slack.send.mock.calls).toContainEqual([
      "slack:T001:D001:099.9", expect.objectContaining({ markdown: "Legacy Home answer" }),
    ]));
    const separate = await slackPrompt(FIRST, "222.2", "Separate root before restart", "Separate answer before restart");
    const homeBefore = await messages(FIRST, savedHome.threadId);
    const separateBefore = await messages(FIRST, separate.id);
    // A later saved native thread must not steal an already bound legacy conversation.
    const nativeId = "fixture-later-native-thread";
    const now = Date.now();
    await api.providers.engineStore.saveThread(savedHome.sessionId, {
      id: nativeId, sessionId: savedHome.sessionId, key: "slack:D001:099.9",
      status: "active", queueMode: "followup", createdAt: now, updatedAt: now,
    });
    await host.stop();
    api.providers.engineHost.evictAll();
    const p = api.providers;
    host = new ChannelHost({
      db: p.db, engineHost: p.engineHost, engineStore: p.engineStore, eventStream: p.eventStream,
      engineCredentials: p.engineCredentials, plugins: [plugin], resolveOrgId: async () => "local-org",
    });
    await host.start();
    expect(await messages(FIRST, savedHome.threadId)).toEqual(homeBefore);
    expect(await messages(FIRST, separate.id)).toEqual(separateBefore);
    faux.appendResponses([fauxAssistantMessage("Legacy Home answer after restart")]);
    await host.handleUpdate("slack", inbound(FIRST, "099.9", "Legacy follow-up after restart"), true);
    await waitForReply(FIRST, savedHome.threadId, "Legacy Home answer after restart");
    await vi.waitFor(() => expect(slack.send.mock.calls).toContainEqual([
      "slack:T001:D001:099.9", expect.objectContaining({ markdown: "Legacy Home answer after restart" }),
    ]));
    const restored = await slackPrompt(FIRST, "222.2", "Separate follow-up after restart", "Separate answer after restart");
    expect(restored.id).toBe(separate.id);
    expect((await threads(FIRST)).filter(thread => thread.key === "slack:D001:099.9").map(thread => thread.id)).toEqual([nativeId]);
    expect(await messages(FIRST, nativeId)).toEqual([]);
    const homeHistory = await messages(FIRST, savedHome.threadId);
    expect(homeHistory.slice(0, homeBefore.length)).toEqual(homeBefore);
    expect(homeHistory.map(message => message.content)).toContain("Saved legacy DM content");
    expect(homeHistory.map(message => message.content)).not.toContain("Separate follow-up after restart");
    const dmHistory = await messages(FIRST, separate.id);
    expect(dmHistory.slice(0, separateBefore.length)).toEqual(separateBefore);
    expect(dmHistory.map(message => message.content)).not.toContain("Legacy follow-up after restart");
    expect((await threads(FIRST, `?fixedOnly=1&fixedId=${savedHome.threadId}`)).map(thread => thread.id)).toEqual([savedHome.threadId]);
    expect((await request(SECOND, `/api/threads/${savedHome.threadId}/messages`)).status).toBe(404);
    expect((await request(SECOND, `/api/threads/${separate.id}/messages`)).status).toBe(404);
  });
});
