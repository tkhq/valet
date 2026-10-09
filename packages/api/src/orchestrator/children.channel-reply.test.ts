/**
 * Delegated child completion over a channel, end to end: a child spawned
 * from a channel turn settles, the ChildWatcher admits `child.settled` to the
 * parent, the parent runs a real (faux-model) turn, and the ChannelHost posts
 * the parent's update to the origin thread. The child stays paused, so its
 * submissions settle only by hand. The child-reply dispatcher runs only when a
 * test calls `retryChildReplies`, so no timer decides when a reply posts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { namespaceInternalDispatchId } from "@valet/engine";
import type {
  ChannelOrigin,
  ChannelTransport,
  OutboundChannelMessage,
  QueueItem,
  SignalContent,
  ValetPlugin,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, childReplyDeliveries, childWatches } from "../schema/index.js";
import { submitSessionPrompt } from "../routes/messages.js";
import { buildChildSender, childSendPromptOptions, ChildWatcher, parentDelegationMetadata, type ChildrenDeps } from "./children.js";

const ORG_ID = "local-org";
const USER_ID = "local-user";
const ORIGIN: ChannelOrigin = { channelType: "fake", threadKey: "fake:C1", reply: "auto" };

class RecordingTransport implements ChannelTransport {
  readonly channelType = "fake";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
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
    return { conversationKey, messageId: "media" };
  }
  async sendGatePrompt(conversationKey: string) {
    return { conversationKey, messageId: "gate" };
  }
  async updateGatePrompt(): Promise<void> {}
}

let api: TestApi | undefined;
let unregister: (() => void) | undefined;

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

/** A delegated child submission, stamped as the real spawner stamps it. */
function delegatedItem(id: string, threadId: string, parent: { sessionId: string; threadId: string }): QueueItem {
  const now = Date.now();
  return {
    id, threadId, content: "delegated work", status: "queued", attemptCount: 0,
    maxAttempts: 10, timeoutAt: now + 3_600_000, createdAt: now, updatedAt: now,
    metadata: parentDelegationMetadata(parent.sessionId, parent.threadId),
  };
}

/** Every `child.settled` submission on a session, oldest first, settled or not. */
async function childSettledSignals(sessionId: string): Promise<Array<QueueItem & { content: SignalContent }>> {
  const { engineStore } = api!.providers;
  const items = [
    ...(await engineStore.listUnsettledSubmissions(sessionId)),
    ...(await engineStore.listSettledSubmissionsBefore(sessionId, Number.MAX_SAFE_INTEGER)),
  ].sort((a, b) => a.createdAt - b.createdAt);
  return items.filter(
    (item): item is QueueItem & { content: SignalContent } =>
      typeof item.content === "object" && item.content !== null && "kind" in item.content &&
      item.content.kind === "signal" && item.content.signalType === "child.settled",
  );
}

/**
 * Boots the API with a running `fake` channel, a live parent that answers
 * every turn with a numbered update, and a paused child whose first
 * submission was spawned from the channel turn `ORIGIN`.
 */
async function bootDelegation(childId: string) {
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  unregister = () => faux.unregister();
  let turn = 0;
  faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage(`Parent update ${++turn}`)));

  const transport = new RecordingTransport();
  const plugin: ValetPlugin = { name: "fake", version: "0", transports: [{ channelType: "fake", create: () => transport }] };
  api = await bootTestApi({ plugins: [plugin] });
  const { engineHost, engineStore, engineCredentials, channelHost, db } = api.providers;
  await engineCredentials.save({ type: "org", id: ORG_ID }, "fake", { type: "bot_token", accessToken: "fake-bot-token" });
  await channelHost.start();
  // Stop the dispatcher's timer, then let the boot pass finish. From here on,
  // only an explicit `retryChildReplies` call delivers a reply.
  channelHost.stopOutbound();
  await channelHost.retryChildReplies();

  const parentId = `parent-${childId}`;
  const parent = await engineHost.sessionFor(parentId, { userId: USER_ID, orgId: ORG_ID, workspace: "/tmp" });
  const parentThread = parent.thread("web:default");
  const child = await engineHost.childSessionFor(childId, {
    parentSessionId: parentId, parentThreadId: parentThread.id, actorUserId: USER_ID, orgId: ORG_ID,
    owner: { type: "user", id: USER_ID }, workspace: "/tmp",
  });
  const childThread = child.thread("web:default");
  await child.pause();
  const queueItemId = `qi-${childId}`;
  await engineStore.admitSubmission(childId, childThread.id, delegatedItem(queueItemId, childThread.id, { sessionId: parentId, threadId: parentThread.id }));

  const now = Date.now();
  await db.insert(agentSessions).values({
    id: childId, userId: USER_ID, orgId: ORG_ID, workspace: "/tmp", status: "active",
    ownerType: "user", ownerId: USER_ID, createdAt: now, updatedAt: now,
  });
  await db.insert(childWatches).values({
    childSessionId: childId, queueItemId, parentSessionId: parentId, parentThreadId: parentThread.id,
    actorUserId: USER_ID, orgId: ORG_ID, settled: false, createdAt: now, originJson: JSON.stringify(ORIGIN),
    replyRoute: "origin",
  });
  const deps: ChildrenDeps = {
    db, engineHost, engineStore, prebuildService: api.providers.prebuildService,
    workspaceRoot: mkdtempSync(join(tmpdir(), "valet-child-reply-test-")),
  };
  const watcher = new ChildWatcher(deps);
  watcher.arm({ childSessionId: childId, queueItemId, parentSessionId: parentId, parentThreadId: parentThread.id, actorUserId: USER_ID, orgId: ORG_ID, origin: ORIGIN });
  return { deps, watcher, transport, parentId, parentThread, child, childThreadId: childThread.id, queueItemId };
}

/**
 * Waits until the watcher admits the parent's update for one child
 * submission, then until the parent's turn for that update settles.
 */
async function parentUpdateSettled(
  run: Awaited<ReturnType<typeof bootDelegation>>,
  childId: string,
  childItemId: string,
): Promise<void> {
  const replyId = namespaceInternalDispatchId(childId, `settled:${childId}:${childItemId}`);
  const parentItemId = await vi.waitFor(async () => {
    const [intent] = await api!.providers.db.select().from(childReplyDeliveries).where(eq(childReplyDeliveries.id, replyId));
    if (!intent?.queueItemId) throw new Error(`The parent update for ${childItemId} is not admitted yet`);
    return intent.queueItemId;
  }, { timeout: 30_000, interval: 20 });
  await run.parentThread.awaitResult(parentItemId);
}

describe("delegated child completion over a channel", () => {
  it("posts the parent's update to the origin thread after an automatic child settles", async () => {
    const run = await bootDelegation("child-auto");
    const { engineStore } = api!.providers;

    await engineStore.settleUnclaimed("child-auto", run.childThreadId, run.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, "child-auto", run.queueItemId);

    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
    expect(run.transport.sent[0]).toMatchObject({ conversationKey: "fake:dm:C1" });
    expect(run.transport.sent[0]?.message.markdown).toMatch(/^Parent update \d+$/);
    const [intent] = await api!.providers.db.select().from(childReplyDeliveries);
    expect(intent?.completedAt).not.toBeNull();
    // Delivery is once: further dispatcher passes do not post again.
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
  });

  it("keeps the origin thread when the delegating parent thread resumes a settled child", async () => {
    const run = await bootDelegation("child-resume");
    const { engineStore } = api!.providers;
    await engineStore.settleUnclaimed("child-resume", run.childThreadId, run.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, "child-resume", run.queueItemId);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);

    // The thread that delegated the task sends follow-up work. The new
    // result still belongs to that thread's channel turn.
    const sender = buildChildSender(run.deps, run.watcher);
    const resumed = await sender(
      { childSessionId: "child-resume", message: "one more thing: add tests" },
      { parentSessionId: run.parentId, parentThreadId: run.parentThread.id, actorUserId: USER_ID },
    );
    if (!resumed) throw new Error("child_send did not admit the follow-up");
    await engineStore.settleUnclaimed("child-resume", run.childThreadId, resumed.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, "child-resume", resumed.queueItemId);

    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(2);
    expect(run.transport.sent.every((sent) => sent.conversationKey === "fake:dm:C1")).toBe(true);
    const signals = await childSettledSignals(run.parentId);
    expect(signals.map((signal) => signal.content.origin)).toEqual([ORIGIN, ORIGIN]);
  });

  it("does not post automatically when another parent thread resumes a settled child", async () => {
    const run = await bootDelegation("child-resume-elsewhere");
    const { db, engineStore } = api!.providers;
    await engineStore.settleUnclaimed("child-resume-elsewhere", run.childThreadId, run.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, "child-resume-elsewhere", run.queueItemId);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);

    // Another parent thread, for example a private DM, continues the work.
    // Its result can carry that thread's context, so it must not post into
    // the channel thread that delegated the original task.
    const sender = buildChildSender(run.deps, run.watcher);
    const resumed = await sender(
      { childSessionId: "child-resume-elsewhere", message: "use the private numbers I gave you" },
      { parentSessionId: run.parentId, parentThreadId: "th-elsewhere", actorUserId: USER_ID },
    );
    if (!resumed) throw new Error("child_send did not admit the follow-up");
    await engineStore.settleUnclaimed("child-resume-elsewhere", run.childThreadId, resumed.queueItemId, { outcome: "completed" });
    const signals = await vi.waitFor(async () => {
      const found = await childSettledSignals(run.parentId);
      if (found.length < 2) throw new Error("the resumed settlement is not admitted yet");
      return found;
    }, { timeout: 30_000, interval: 20 });
    await run.parentThread.awaitResult(signals[1]!.id);

    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
    expect(signals.map((signal) => signal.content.origin)).toEqual([ORIGIN, { ...ORIGIN, reply: "manual" }]);
    expect(await db.select().from(childReplyDeliveries)).toHaveLength(1);
  });

  it.each([
    { input: "a queued followup", childId: "child-keep-followup", sideThread: false },
    { input: "a message on another child thread", childId: "child-keep-side", sideThread: true },
  ])("keeps the origin thread when a person sends $input", async ({ childId, sideThread }) => {
    const run = await bootDelegation(childId);
    const { db, engineStore } = api!.providers;
    const [childRow] = await db.select().from(agentSessions).where(eq(agentSessions.id, childId));
    if (!childRow) throw new Error("child session row missing");

    // Neither input replaces the delegated work, so its result still
    // belongs to the channel turn that delegated it.
    const sent = await submitSessionPrompt(api!.providers, childRow, "Also note this for later", sideThread
      ? { threadId: run.child.thread("web:side").id, queueMode: "steer", author: { id: USER_ID } }
      : { threadId: run.childThreadId, queueMode: "followup", author: { id: USER_ID } });
    if (!sent?.messageId) throw new Error("human input was not admitted");
    expect((await engineStore.getQueueItem(childId, run.queueItemId))?.supersededByItemId).toBeUndefined();

    await engineStore.settleUnclaimed(childId, run.childThreadId, run.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, childId, run.queueItemId);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
    expect(run.transport.sent[0]?.conversationKey).toBe("fake:dm:C1");
    const signals = await childSettledSignals(run.parentId);
    expect(signals.map((signal) => signal.content.origin)).toEqual([ORIGIN]);
  });

  it("keeps the origin thread when the watcher recovers an interrupted parent child_send", async () => {
    const run = await bootDelegation("child-crash");
    const { db, engineStore } = api!.providers;
    // The parent's child_send admitted its steer, then the process stopped
    // before the sender moved the watch. The watcher follows the steer.
    const steer = await run.child.prompt("one more thing: add tests",
      childSendPromptOptions({ parentSessionId: run.parentId, parentThreadId: run.parentThread.id, actorUserId: USER_ID }, false));
    await vi.waitFor(async () => {
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-crash"));
      expect(watch?.queueItemId).toBe(steer.queueItemId);
    }, { timeout: 30_000, interval: 20 });

    await engineStore.settleUnclaimed("child-crash", run.childThreadId, steer.queueItemId, { outcome: "completed" });
    await parentUpdateSettled(run, "child-crash", steer.queueItemId);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
    expect(run.transport.sent[0]?.conversationKey).toBe("fake:dm:C1");
    expect((await childSettledSignals(run.parentId)).map((signal) => signal.content.origin)).toEqual([ORIGIN]);
  });

  it("does not post automatically after recovering an interrupted child_send from another parent thread", async () => {
    const run = await bootDelegation("child-crash-elsewhere");
    const { db, engineStore } = api!.providers;
    // Another parent thread sent a steer, then the process stopped before
    // the sender moved the watch and stored the manual route.
    const steer = await run.child.prompt("use the private numbers I gave you",
      childSendPromptOptions({ parentSessionId: run.parentId, parentThreadId: "th-elsewhere", actorUserId: USER_ID }, false));
    await vi.waitFor(async () => {
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-crash-elsewhere"));
      expect(watch?.queueItemId).toBe(steer.queueItemId);
    }, { timeout: 30_000, interval: 20 });

    await engineStore.settleUnclaimed("child-crash-elsewhere", run.childThreadId, steer.queueItemId, { outcome: "completed" });
    const signals = await vi.waitFor(async () => {
      const found = await childSettledSignals(run.parentId);
      if (found.length < 1) throw new Error("the settlement is not admitted yet");
      return found;
    }, { timeout: 30_000, interval: 20 });
    await run.parentThread.awaitResult(signals[0]!.id);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(0);
    expect(signals.map((signal) => signal.content.origin)).toEqual([{ ...ORIGIN, reply: "manual" }]);
    expect(await db.select().from(childReplyDeliveries)).toHaveLength(0);
  });

  it("keeps the origin thread when a person sends the queued delegated work now", async () => {
    const run = await bootDelegation("child-send-now");
    const { db, engineStore } = api!.providers;
    const [childRow] = await db.select().from(agentSessions).where(eq(agentSessions.id, "child-send-now"));
    if (!childRow) throw new Error("child session row missing");

    // "Send now" moves the delegated work ahead. It is still the parent's work.
    const promoted = await submitSessionPrompt(api!.providers, childRow, "", {
      threadId: run.childThreadId, promoteItemId: run.queueItemId, author: { id: USER_ID },
    });
    const successor = promoted?.messageId;
    if (!successor) throw new Error("the delegated item was not promoted");
    await vi.waitFor(async () => {
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-send-now"));
      expect(watch?.queueItemId).toBe(successor);
    }, { timeout: 30_000, interval: 20 });

    await engineStore.settleUnclaimed("child-send-now", run.childThreadId, successor, { outcome: "completed" });
    await parentUpdateSettled(run, "child-send-now", successor);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(1);
    expect((await childSettledSignals(run.parentId)).map((signal) => signal.content.origin)).toEqual([ORIGIN]);
  });

  it("treats a watch written before reply routes as manual", async () => {
    const run = await bootDelegation("child-legacy");
    const { db, engineStore } = api!.providers;
    // A row from before the reply_route column. Its history (a takeover, or
    // work from another parent thread) is unknown, so it never posts on its own.
    await db.update(childWatches).set({ replyRoute: null }).where(eq(childWatches.childSessionId, "child-legacy"));

    await engineStore.settleUnclaimed("child-legacy", run.childThreadId, run.queueItemId, { outcome: "completed" });
    const signals = await vi.waitFor(async () => {
      const found = await childSettledSignals(run.parentId);
      if (found.length < 1) throw new Error("the settlement is not admitted yet");
      return found;
    }, { timeout: 30_000, interval: 20 });
    await run.parentThread.awaitResult(signals[0]!.id);
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(0);
    expect(signals.map((signal) => signal.content.origin)).toEqual([{ ...ORIGIN, reply: "manual" }]);
    expect(await db.select().from(childReplyDeliveries)).toHaveLength(0);
  });

  it("drops the origin thread when a person takes over the child", async () => {
    const run = await bootDelegation("child-takeover");
    const { db, engineStore } = api!.providers;
    const [childRow] = await db.select().from(agentSessions).where(eq(agentSessions.id, "child-takeover"));
    if (!childRow) throw new Error("child session row missing");

    // A person steers the child from the web UI. The work now answers to
    // them, not to the channel thread that delegated the original task.
    const takeover = await submitSessionPrompt(api!.providers, childRow, "Stop, do it my way instead", {
      threadId: run.childThreadId, queueMode: "steer", author: { id: USER_ID },
    });
    const successor = takeover?.messageId;
    if (!successor) throw new Error("human steer was not admitted");
    await vi.waitFor(async () => {
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-takeover"));
      expect(watch?.queueItemId).toBe(successor);
    }, { timeout: 30_000, interval: 50 });
    await engineStore.settleUnclaimed("child-takeover", run.childThreadId, successor, { outcome: "completed" });

    await vi.waitFor(async () => {
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-takeover"));
      expect(watch?.settled).toBe(true);
    }, { timeout: 30_000, interval: 50 });
    const signals = await childSettledSignals(run.parentId);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.content.origin).toBeUndefined();
    // Let the parent finish its turn and a dispatcher pass run: nothing posts.
    await vi.waitFor(async () => {
      expect((await engineStore.getQueueItem(run.parentId, signals[0]!.id))?.status).toBe("settled");
    }, { timeout: 30_000, interval: 50 });
    await api!.providers.channelHost.retryChildReplies();
    expect(run.transport.sent).toHaveLength(0);
    expect(await db.select().from(childReplyDeliveries)).toHaveLength(0);
  });
});
