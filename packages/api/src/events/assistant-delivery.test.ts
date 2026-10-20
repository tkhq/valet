import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { fauxAssistantMessage, fauxToolCall, Type, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { UNATTENDED_DELIVERY_KEY, UNATTENDED_WORKFLOW_KEY } from "@valet/shared";
import { PgEventStream, PgSessionStore } from "@valet/store-postgres";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineHost } from "../engine/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { assistantExecutions, assistants, sessionThreads, slackChannelPrivacy, teams, users } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { deliverToAssistantThread, PinUnavailableError, pinNarrowsMessage } from "./assistant-delivery.js";

const ORG = "org-1";
const USER = "user-1";
const OWNER = { type: "org" as const, id: ORG };

/** Wait for the first user message the delivery submitted to land on the thread. */
async function firstUserEntry(
  deps: { db: TestPgDb["appDb"]; engineHost: EngineHost },
  threadKey: string,
): Promise<MessageEntry | undefined> {
  const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
  const threadId = session.thread(threadKey).id;
  for (let i = 0; i < 100; i++) {
    const entries = await session.providers.store.getEntries(session.id, threadId);
    const entry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

describe("deliverToAssistantThread — thread-context hydration", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      scratchCaps: {},
      wakeupLimits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  const channelSignal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
    origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" as const },
  });

  it("creates a shared runtime with a machine actor and persists that identity", async () => {
    const deps = { db: testDb.appDb, engineHost };
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: `org:${ORG}`, destination: { kind: "key", key: "events" },
      signal: { kind: "signal", signalType: "github.issues.opened", body: "External issue" },
      dispatchId: "machine-delivery", mismatchReason: "test",
    });
    expect(await firstUserEntry(deps, "events")).toMatchObject({ author: { id: `org:${ORG}` } });
  });

  it("persists each delivery actor on a cached session without rebinding its owner", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
    for (const actor of ["member-b", "member-c"]) {
      const threadKey = `slack:C1:${actor}`;
      await deliverToAssistantThread(deps, {
        orgId: ORG, owner: OWNER, actorUserId: actor, destination: { kind: "key", key: threadKey },
        signal: channelSignal(actor), dispatchId: actor, mismatchReason: "test",
      });
      expect(await firstUserEntry(deps, threadKey)).toMatchObject({ author: { id: actor } });
    }
    expect(session.options.userId).toBe(USER);
    expect(session.owner).toEqual(OWNER);
  });

  it("persists presence per delivery without changing other turns", async () => {
    const deps = { db: testDb.appDb, engineHost };
    for (const [dispatchId, presence] of [
      ["presence-first", { displayName: "Hestia", avatarUrl: "https://example.com/hestia.webp" }],
      ["presence-default", undefined],
    ] as const) {
      await deliverToAssistantThread(deps, {
        orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "events" },
        signal: { kind: "signal", signalType: "test", body: dispatchId },
        dispatchId, presence, mismatchReason: "test",
      });
      const result = await testDb.appDb.execute(sql`SELECT metadata FROM engine_queue_items WHERE dispatch_id = ${dispatchId}`) as { rows: Array<{ metadata: unknown }> };
      const metadata = result.rows[0]?.metadata;
      expect(typeof metadata === "string" ? JSON.parse(metadata) : metadata).toEqual(presence ? { presence } : null);
    }
  });

  it("marks an unattended delivery so its turn refuses questions instead of parking the thread", async () => {
    const deps = { db: testDb.appDb, engineHost };
    for (const [dispatchId, unattended] of [["unattended-event", true], ["attended-event", undefined]] as const) {
      await deliverToAssistantThread(deps, {
        orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "events" },
        signal: { kind: "signal", signalType: "test", body: dispatchId },
        dispatchId, mismatchReason: "test", ...(unattended ? { unattended } : {}),
      });
      const result = await testDb.appDb.execute(sql`SELECT metadata FROM engine_queue_items WHERE dispatch_id = ${dispatchId}`) as { rows: Array<{ metadata: unknown }> };
      const metadata = result.rows[0]?.metadata;
      expect(typeof metadata === "string" ? JSON.parse(metadata) : metadata).toEqual(unattended ? { [UNATTENDED_DELIVERY_KEY]: true } : null);
    }
  });

  it("uses the current team defaults for new Slack threads after restore", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type: "team", id: "team-defaults" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Defaults", createdAt: Date.now(), defaultModel: "claude-opus-4-5", defaultReasoning: "high" });
    const session = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    const oldThread = await session.createThread("slack:C1:old", { model: "claude-sonnet-4-5", reasoning: "low" });
    await testDb.appDb.update(teams).set({ defaultModel: "m", defaultReasoning: "low" }).where(eq(teams.id, owner.id));
    // A team runtime must not inherit the member who delivered the event.
    await testDb.appDb.insert(users).values({ id: USER, email: "event-model@example.com", name: "Event user", defaultModel: "l" });
    engineHost.evictAll();

    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: owner, actorUserId: USER,
      destination: { kind: "key", key: "slack:C1:1.2" }, signal: channelSignal("first"),
      dispatchId: "model-first", mismatchReason: "event_target_mismatch",
    });
    const restored = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    expect((await restored.threadByKey("slack:C1:1.2"))?.modelId()).toBe("m");
    expect((await restored.threadByKey("slack:C1:1.2"))?.reasoning()).toBe("low");
    expect(restored.threadById(oldThread.id)?.modelId()).toBe("claude-sonnet-4-5");
    expect(restored.options.modelSpec).toBe("claude-opus-4-5");

    await testDb.appDb.update(teams).set({ defaultModel: null, defaultReasoning: null }).where(eq(teams.id, owner.id));
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: owner, actorUserId: USER,
      destination: { kind: "key", key: "slack:C1:next" }, signal: channelSignal("next"),
      dispatchId: "model-next", mismatchReason: "event_target_mismatch",
    });
    expect((await restored.threadByKey("slack:C1:next"))?.modelId()).toBe("s");
    expect((await restored.threadByKey("slack:C1:next"))?.reasoning()).toBe("medium");
    expect((await restored.threadByKey("slack:C1:1.2"))?.modelId()).toBe("m");
  });

  it.each(["queued", "settled"])("keeps a %s pre-upgrade event admission when channel routing changes", async (state) => {
    const owner = { type: "team", id: "cutover-team" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Cutover team", createdAt: 1 });
    const deps = { db: testDb.appDb, engineHost };
    const root = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    await testDb.appDb.execute(sql`INSERT INTO legacy_assistant_runtimes (session_id, org_id) VALUES (${root.id}, ${ORG})`);
    engineHost.evictCache(root.id);
    const original = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    const externalAction = vi.fn(async () => ({ text: "sent once" }));
    original.options.tools = [...(original.options.tools ?? []), {
      name: "external_write", description: "Send an external update", parameters: Type.Object({}), execute: externalAction,
    }];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("external_write", {}, { id: "external-once" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("sent"),
    ]);
    const thread = original.thread("events");
    if (state === "queued") await thread.pause();
    const signal = { kind: "signal" as const, signalType: "slack.reaction_added", body: "Review this reaction", attributes: { eventId: "old-event", service: "slack" } };
    const receipt = await thread.submitPrompt(signal, { dispatchId: "event:cutover-delivery" });
    if (state === "settled") await thread.awaitResult(receipt.queueItemId);
    const remaining = faux.getPendingResponseCount();
    engineHost.evictCache(original.id);
    for (let retry = 0; retry < 2; retry++) {
      await deliverToAssistantThread(deps, {
        orgId: ORG, owner, actorUserId: USER, destination: { kind: "key", key: "sub:rule-unattended:delivery-2" }, signal,
        dispatchId: "event:cutover-delivery", mismatchReason: "event_target_mismatch",
      });
      engineHost.evictCache(original.id);
    }
    const rows = await testDb.appDb.execute(sql`SELECT id, session_id, thread_id FROM engine_queue_items WHERE dispatch_id = 'event:cutover-delivery'`) as { rows: Array<{ id: string; session_id: string; thread_id: string }> };
    expect(rows.rows).toEqual([{ id: receipt.queueItemId, session_id: original.id, thread_id: thread.id }]);
    expect(await testDb.appDb.select().from(assistantExecutions)).toHaveLength(0);
    expect(faux.getPendingResponseCount()).toBe(remaining);
    expect(externalAction).toHaveBeenCalledTimes(state === "settled" ? 1 : 0);
  });

  it("admits one team schedule slot once when its thread policy changes before a retry", async () => {
    const owner = { type: "team", id: "routine-team" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Routine team", createdAt: 1 });
    const deps = { db: testDb.appDb, engineHost };
    const signal = { kind: "signal" as const, signalType: "schedule", body: "Post the standup summary", attributes: { scheduleId: "sched-1" } };
    const args = { orgId: ORG, owner, actorUserId: `team:${owner.id}`, signal, dispatchId: "schedule:sched-1:100",
      mismatchReason: "test", unattended: true };
    // `own` admits the slot in the routine's own execution session.
    const first = await deliverToAssistantThread(deps, { ...args, destination: { kind: "key", key: "schedule:sched-1", title: "Standup" } });
    // The policy changes to `new`, which selects another execution session.
    const retry = await deliverToAssistantThread(deps, { ...args, destination: { kind: "key", key: "schedule:sched-1:100", title: "Standup" } });
    expect(retry).toEqual({ ...first, recovered: true });
    const rows = await testDb.appDb.execute(sql`SELECT session_id FROM engine_queue_items WHERE dispatch_id = 'schedule:sched-1:100'`) as { rows: Array<{ session_id: string }> };
    expect(rows.rows).toEqual([{ session_id: first.sessionId }]);
  });

  it("recovers the admitted event before a new PR target and verifies its original content", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
    const thread = session.thread("events");
    await thread.pause();
    const signal = channelSignal("review the change");
    const seeded = { ...signal, body: `Conversation so far in this thread:\nEarlier history\n\n---\n\n${signal.body}` };
    const admitted = await thread.submitPrompt(seeded, { dispatchId: "event:pr-cutover" });
    const args = { orgId: ORG, owner: OWNER, actorUserId: USER,
      destination: { kind: "target" as const, sessionId: "new-pr-runtime", threadId: "new-pr-thread" }, signal,
      dispatchId: "event:pr-cutover", mismatchReason: "test" };
    await expect(deliverToAssistantThread(deps, args)).resolves.toEqual({ sessionId: session.id, threadId: thread.id, recovered: true });
    await expect(deliverToAssistantThread(deps, { ...args, signal: channelSignal("changed work") })).rejects.toThrow("different content");
    expect((await session.providers.store.listUnsettledSubmissions(session.id)).map(item => item.id)).toEqual([admitted.queueItemId]);
    await expect(deliverToAssistantThread(deps, { ...args, owner: { type: "user", id: USER } })).rejects.toThrow("original event owner differs");
    // An identical ID in another organization must not resolve this receipt.
    await expect(deliverToAssistantThread(deps, { ...args, orgId: "other-org" })).rejects.toThrow("original conversation is unavailable");
  });

  it("restores the exact private PR thread and refuses deliveries archived while queued", async () => {
    const owner = { type: "team", id: "pr-team" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "PR team", createdAt: 1 });
    const deps = { db: testDb.appDb, engineHost };
    const key = `app-assistant:${USER}`;
    const { session } = await ensureAssistantExecution(deps, owner, { actorUserId: USER, orgId: ORG }, key);
    const thread = await session.createThread("web:original-pr");
    await thread.pause();
    engineHost.evictCache(session.id);
    const args = { orgId: ORG, owner, actorUserId: USER,
      destination: { kind: "target" as const, sessionId: session.id, threadId: thread.id }, signal: channelSignal("Review feedback"),
      dispatchId: "cold-pr-reply", mismatchReason: "test" };
    await deliverToAssistantThread(deps, args);
    const restored = engineHost.liveSession(session.id)!;
    expect(restored).not.toBe(session);
    expect(await restored.providers.store.listUnsettledSubmissions(session.id)).toEqual([
      expect.objectContaining({ threadId: thread.id }),
    ]);

    const empty = await restored.createThread("web:queued-pr");
    await empty.pause();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const fetchThreadContext = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return "Earlier review"; };
    const target = { kind: "target" as const, sessionId: session.id, threadId: empty.id };
    const first = deliverToAssistantThread({ ...deps, fetchThreadContext }, { ...args, destination: target, dispatchId: "queued-first" });
    await waiting;
    const second = deliverToAssistantThread(deps, { ...args, destination: target, dispatchId: "queued-second" });
    const results = Promise.allSettled([first, second]);
    await testDb.appDb.insert(sessionThreads).values({ id: empty.id, sessionId: session.id, createdAt: 1, archivedAt: Date.now() });
    release();
    expect(await results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("archived or deleted") }) },
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("archived or deleted") }) },
    ]);
    expect((await restored.providers.store.listUnsettledSubmissions(session.id)).some(item => item.threadId === empty.id)).toBe(false);
  });

  it("prepends the fetched thread transcript on the first turn in a channel thread", async () => {
    const fetchThreadContext = vi.fn(async () => "Brian: kicking this off\nConner: this needs a skill");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        destination: { kind: "key", key: "slack:C1:1.2" },
        signal: channelSignal("file an issue for this"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );

    const entry = await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");
    expect(fetchThreadContext).toHaveBeenCalledOnce();
    expect(entry?.content).toBe(
      "Conversation so far in this thread:\n" +
        "Brian: kicking this off\nConner: this needs a skill\n\n---\n\n" +
        "file an issue for this",
    );
  });

  it("does not fetch or prepend when the thread already has entries", async () => {
    // Seed the thread with a first delivery (no hook), then deliver again with a hook.
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        destination: { kind: "key", key: "slack:C1:1.2" },
        signal: channelSignal("first"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );
    await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");

    const fetchThreadContext = vi.fn(async () => "should not be used");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        destination: { kind: "key", key: "slack:C1:1.2" },
        signal: channelSignal("second"),
        dispatchId: "d2",
        mismatchReason: "event_target_mismatch",
      },
    );
    expect(fetchThreadContext).not.toHaveBeenCalled();
  });

  it("two racing deliveries on one new thread seed the transcript exactly once (TKAI-284)", async () => {
    // A slow transcript fetch is the race window: without per-thread
    // serialization, both deliveries pass the empty-thread check during the
    // other's fetch and both prepend.
    const fetchThreadContext = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "Brian: earlier context";
    });
    await Promise.all([
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          destination: { kind: "key", key: "slack:C1:1.2" },
          signal: channelSignal("mention one"),
          dispatchId: "d1",
          mismatchReason: "event_target_mismatch",
        },
      ),
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          destination: { kind: "key", key: "slack:C1:1.2" },
          signal: channelSignal("mention two"),
          dispatchId: "d2",
          mismatchReason: "event_target_mismatch",
        },
      ),
    ]);
    expect(fetchThreadContext).toHaveBeenCalledOnce();

    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, OWNER, {
      actorUserId: USER,
      orgId: ORG,
    });
    const threadId = session.thread("slack:C1:1.2").id;
    let seeded: string[] = [];
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      const userBodies = entries
        .filter((e): e is MessageEntry => e.type === "message" && e.role === "user")
        .map((e) => e.content ?? "");
      if (userBodies.length >= 2) {
        seeded = userBodies.filter((b) => b.includes("Conversation so far in this thread:"));
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seeded).toHaveLength(1);
  });
});

describe("deliverToAssistantThread — which assistant answers", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      scratchCaps: {},
      wakeupLimits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  const signal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
  });

  it("ends an unattended delivery that asks a question instead of parking its thread", async () => {
    // The incident: an event delivery asked a question, waited for days, and
    // every later delivery on its thread queued behind it.
    const deps = { db: testDb.appDb, engineHost };
    const pending = async () => ((await testDb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_decision_gates
      WHERE status = 'pending'`)) as { rows: Array<{ n: number }> }).rows[0]!.n;
    const settled = async (dispatchId: string) => ((await testDb.appDb.execute(sql`SELECT status FROM engine_queue_items
      WHERE dispatch_id = ${dispatchId}`)) as { rows: Array<{ status: string }> }).rows[0]?.status === "settled";
    const asks = () => faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which post should I triage?" }, { id: "ask-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Nothing to triage."),
    ]);

    asks();
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "events" }, unattended: true,
      signal: signal("bot post"), dispatchId: "unattended-ask", mismatchReason: "event_target_mismatch",
    });
    await expect.poll(() => settled("unattended-ask"), { timeout: 15_000 }).toBe(true);
    expect(await pending()).toBe(0);

    // A signal on an automated delivery thread with no flag, such as a delegated
    // task's follow-up or an item queued before this change, is unattended too.
    asks();
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "slack-events:C1" },
      signal: signal("child settled"), dispatchId: "thread-rule-ask", mismatchReason: "event_target_mismatch",
    });
    await expect.poll(() => settled("thread-rule-ask"), { timeout: 15_000 }).toBe(true);
    expect(await pending()).toBe(0);

    // Without the flag, the same question parks the thread.
    asks();
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "mentions" },
      signal: signal("a person asks"), dispatchId: "attended-ask", mismatchReason: "event_target_mismatch",
    });
    await expect.poll(() => pending(), { timeout: 15_000 }).toBe(1);
    expect(await settled("attended-ask")).toBe(false);
  });

  it("lets a default-policy Slack mention ask on its rule thread and keeps a reaction there unattended", async () => {
    // A rule with no stored policy lands a mention on `sub:<rule>:<delivery>`.
    // The dispatcher leaves `unattended` unset for a channel conversation, so
    // the person who mentioned the assistant must be able to answer it.
    const deps = { db: testDb.appDb, engineHost };
    const pending = async () => ((await testDb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_decision_gates
      WHERE status = 'pending'`)) as { rows: Array<{ n: number }> }).rows[0]!.n;
    const settled = async (dispatchId: string) => ((await testDb.appDb.execute(sql`SELECT status FROM engine_queue_items
      WHERE dispatch_id = ${dispatchId}`)) as { rows: Array<{ status: string }> }).rows[0]?.status === "settled";
    const asks = () => faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which deploy?" }, { id: "ask-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Nothing to check."),
    ]);
    const conversational = async (key: string) => {
      const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
      return (await session.threadByKey(key))?.toThreadData().metadata?.conversational;
    };

    // A reaction on a rule thread with no conversation stays unattended.
    asks();
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "sub:rule-reactions" }, unattended: true,
      signal: signal("eyes on a post"), dispatchId: "event:reaction-1", mismatchReason: "event_target_mismatch",
    });
    await expect.poll(() => settled("event:reaction-1"), { timeout: 15_000 }).toBe(true);
    expect(await pending()).toBe(0);
    expect(await conversational("sub:rule-reactions")).toBeUndefined();

    asks();
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "sub:rule-mentions:delivery-1" },
      signal: { ...signal("is the deploy green?"), origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" as const } },
      dispatchId: "event:mention-1", mismatchReason: "event_target_mismatch",
    });
    await expect.poll(() => pending(), { timeout: 15_000 }).toBe(1);
    expect(await settled("event:mention-1")).toBe(false);
    expect(await conversational("sub:rule-mentions:delivery-1")).toBe(true);
  });

  it("lets a task that an automated delivery starts ask in the inbox", async () => {
    // A task does not wait for its child, so the child's question never holds
    // the shared thread. Only a workflow task makes the child unattended too.
    const spawned: Array<boolean | undefined> = [];
    const host = new EngineHost({
      engineStore: new PgSessionStore(testDb.pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(testDb.pgdb),
      engineCredentials: new PgCredentialStore(testDb.pgdb, deriveSecretKey("test-key")),
      db: testDb.appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
      scratchCaps: {},
      wakeupLimits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
      childSpawner: async (_req, ctx) => {
        spawned.push(ctx.unattendedWorkflow);
        return { childSessionId: `child-${spawned.length}`, queueItemId: `child-item-${spawned.length}` };
      },
    });
    const deps = { db: testDb.appDb, engineHost: host };
    const delegates = () => faux.setResponses([
      fauxAssistantMessage([fauxToolCall("task", { prompt: "Approve the pull request." }, { id: "task-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Started a task."),
    ]);
    const settled = async (dispatchId: string) => ((await testDb.appDb.execute(sql`SELECT status FROM engine_queue_items
      WHERE dispatch_id = ${dispatchId}`)) as { rows: Array<{ status: string }> }).rows[0]?.status === "settled";
    try {
      for (const [threadKey, unattended] of [["events", true], ["slack-events:C1", undefined], ["signal:workflow:wfrun_1", undefined]] as const) {
        delegates();
        await deliverToAssistantThread(deps, {
          orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: threadKey }, signal: signal("delegate"), dispatchId: threadKey,
          mismatchReason: "event_target_mismatch", ...(unattended ? { unattended } : {}),
        });
        await expect.poll(() => settled(threadKey), { timeout: 15_000 }).toBe(true);
      }
      // A workflow task handed to an assistant thread.
      delegates();
      const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
      const thread = await session.createThread("workflow-task");
      const receipt = await thread.submitPrompt("report", { metadata: { [UNATTENDED_WORKFLOW_KEY]: true } });
      await thread.awaitResult(receipt.queueItemId);
      expect(spawned).toEqual([undefined, undefined, true, true]);
    } finally {
      await host.destroyAll();
    }
  });

  it("delivers into the owner's singleton and persists the initiating actor", async () => {
    const deps = { db: testDb.appDb, engineHost };
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, destination: { kind: "key", key: "events" },
      signal: signal("go"), dispatchId: "d1", mismatchReason: "event_target_mismatch",
    });
    expect(await firstUserEntry(deps, "events")).toMatchObject({ content: "go", author: { id: USER } });
    const rows = await testDb.appDb.select().from(assistants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerType: OWNER.type, ownerId: OWNER.id });
  });
});

describe("deliverToAssistantThread: destinations (spec 2026-10-16: delivery threads, Part B)", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("(noted)")));
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      scratchCaps: {},
      wakeupLimits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  const signal = (body: string) => ({ kind: "signal" as const, signalType: "linear.issue.update", body, attributes: {} });
  const base = { orgId: ORG, owner: OWNER, actorUserId: USER, mismatchReason: "event_target_mismatch" };

  async function threadsWithKey(key: string): Promise<Array<{ id: string }>> {
    const result = await testDb.appDb.execute(sql`SELECT id FROM engine_threads WHERE key = ${key}`) as { rows: Array<{ id: string }> };
    return result.rows;
  }

  async function mirrorRow(threadId: string) {
    const [row] = await testDb.appDb.select().from(sessionThreads).where(eq(sessionThreads.id, threadId));
    return row;
  }

  it("own: creates one thread titled by the rule name and reuses it", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const destination = { kind: "key" as const, key: "sub:rule-eng", title: "ENG triage" };
    const first = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("ENG-42"), dispatchId: "event:d1" });
    const second = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("ENG-43"), dispatchId: "event:d2" });
    expect(second).toEqual(first);
    expect(await threadsWithKey("sub:rule-eng")).toEqual([{ id: first.threadId }]);
    expect((await mirrorRow(first.threadId))?.title).toBe("ENG triage");
    const session = engineHost.liveSession(first.sessionId);
    expect(session?.threadById(first.threadId)?.toThreadData().metadata?.title).toBe("ENG triage");
  });

  it("new: a retry of one delivery reuses its thread (INV-D4)", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const args = { ...base, destination: { kind: "key" as const, key: "sub:rule-ci:delivery-2", title: "CI failed on main" }, signal: signal("CI failed"), dispatchId: "event:delivery-2" };
    const first = await deliverToAssistantThread(deps, args);
    const retry = await deliverToAssistantThread(deps, args);
    // The retry finds the admitted dispatch and submits nothing new.
    expect(retry).toEqual({ ...first, recovered: true });
    expect(await threadsWithKey("sub:rule-ci:delivery-2")).toHaveLength(1);
    const admitted = await testDb.appDb.execute(sql`SELECT id FROM engine_queue_items WHERE dispatch_id = 'event:delivery-2'`) as { rows: unknown[] };
    expect(admitted.rows).toHaveLength(1);
  });

  it("subject: two rules on one pull request share one thread (INV-D8)", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const destination = { kind: "key" as const, key: "subject:github:acme/api#12", title: "acme/api#12" };
    const review = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("review"), dispatchId: "event:rule-a-delivery" });
    const checks = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("checks"), dispatchId: "event:rule-b-delivery" });
    expect(checks).toEqual(review);
    expect(await threadsWithKey("subject:github:acme/api#12")).toHaveLength(1);
  });

  it("own: an archived thread found by key reopens on delivery", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const destination = { kind: "key" as const, key: "sub:rule-eng", title: "ENG triage" };
    const first = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("ENG-42"), dispatchId: "event:d1" });
    await testDb.appDb.update(sessionThreads).set({ archivedAt: Date.now() }).where(eq(sessionThreads.id, first.threadId));
    const again = await deliverToAssistantThread(deps, { ...base, destination, signal: signal("ENG-42 again"), dispatchId: "event:d2" });
    expect(again).toEqual(first);
    expect((await mirrorRow(first.threadId))?.archivedAt).toBeNull();
  });

  it("existing: an archived pin throws the fix text and creates or reopens no thread (INV-D3)", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
    const pinned = await session.createThread("web:platform-ci");
    const archivedAt = Date.now();
    await testDb.appDb.insert(sessionThreads).values({ id: pinned.id, sessionId: session.id, createdAt: 1, archivedAt, title: "Platform CI" });
    const before = await testDb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_threads`) as { rows: Array<{ n: number }> };
    await expect(deliverToAssistantThread(deps, {
      ...base, signal: signal("CI failed"), dispatchId: "event:pin-delivery",
      destination: { kind: "target", sessionId: session.id, threadId: pinned.id, reason: "policy_existing" },
    })).rejects.toThrow(new PinUnavailableError());
    const after = await testDb.appDb.execute(sql`SELECT count(*)::int AS n FROM engine_threads`) as { rows: Array<{ n: number }> };
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await mirrorRow(pinned.id))?.archivedAt).toBe(archivedAt);
    const admitted = await testDb.appDb.execute(sql`SELECT id FROM engine_queue_items WHERE dispatch_id = 'event:pin-delivery'`) as { rows: unknown[] };
    expect(admitted.rows).toHaveLength(0);
  });

  it("existing: refuses to record a private channel on a shared pinned thread and leaves its audience alone", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type: "team", id: "team-pin" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Pin", createdAt: 1 });
    await testDb.appDb.insert(slackChannelPrivacy).values([
      { orgId: ORG, channelId: "CPRIV", isPrivate: true, checkedAt: Date.now() },
      { orgId: ORG, channelId: "CPUB", isPrivate: false, checkedAt: Date.now() },
    ]);
    const { session } = await ensureAssistantExecution(deps, owner, { actorUserId: USER, orgId: ORG }, "web:standup");
    const pinned = await session.createThread("web:standup");
    const destination = { kind: "target" as const, sessionId: session.id, threadId: pinned.id, reason: "policy_existing" as const };
    const stored = async () => (await session.providers.store.getThread(session.id, pinned.id))?.metadata?.slackChannels;

    await expect(deliverToAssistantThread(deps, {
      ...base, owner, destination, signal: signal("from a private channel"), dispatchId: "event:pin-private", slackChannel: "CPRIV",
    })).rejects.toThrow(new PinUnavailableError(pinNarrowsMessage("CPRIV")));
    expect(pinned.toThreadData().metadata?.slackChannels).toBeUndefined();
    expect(await stored()).toBeUndefined();
    const admitted = await testDb.appDb.execute(sql`SELECT id FROM engine_queue_items WHERE dispatch_id = 'event:pin-private'`) as { rows: unknown[] };
    expect(admitted.rows).toHaveLength(0);

    // A public channel narrows nobody, so it lands and is recorded.
    await deliverToAssistantThread(deps, {
      ...base, owner, destination, signal: signal("from a public channel"), dispatchId: "event:pin-public", slackChannel: "CPUB",
    });
    expect(await stored()).toEqual(["CPUB"]);
  });

  it("records the Slack channel before the title shows and before the context fetch", async () => {
    const owner = { type: "team", id: "team-first" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "First", createdAt: 1 });
    const saves = vi.spyOn(PgSessionStore.prototype, "saveThread");
    // Every titled thread the fetch could race with must already carry the channel.
    const titledWithoutChannel = async () => {
      const result = await testDb.appDb.execute(sql`SELECT id FROM engine_threads
        WHERE metadata::jsonb ->> 'title' = 'First private' AND NOT COALESCE(metadata::jsonb -> 'slackChannels' ? 'CFIRST', false)`) as { rows: unknown[] };
      return result.rows.length;
    };
    const governingWithoutChannel = async () => {
      const result = await testDb.appDb.execute(sql`SELECT et.id FROM assistant_executions ae
        JOIN assistants a ON a.id = ae.assistant_id
        JOIN engine_threads et ON et.session_id = a.session_id AND et.id = ae.governing_thread_id
        WHERE a.owner_id = ${owner.id} AND NOT COALESCE(et.metadata::jsonb -> 'slackChannels' ? 'CFIRST', false)`) as { rows: unknown[] };
      return result.rows.length;
    };
    const seen: number[] = [];
    const fetchThreadContext = vi.fn(async () => {
      seen.push(await titledWithoutChannel(), await governingWithoutChannel());
      return "Earlier messages";
    });
    try {
      await deliverToAssistantThread({ db: testDb.appDb, engineHost, fetchThreadContext }, {
        ...base, owner, destination: { kind: "key", key: "sub:rule-first", title: "First private" },
        signal: { ...signal("first"), origin: { channelType: "slack", threadKey: "slack:CFIRST:1.1", reply: "auto" as const } },
        dispatchId: "event:first-1", slackChannel: "CFIRST",
      });
      expect(fetchThreadContext).toHaveBeenCalledOnce();
      expect(seen).toEqual([0, 0]);
      // The write that creates each thread, the execution thread and its
      // governing thread, holds both the title and the channel.
      const firstWrites = new Map<string, Record<string, unknown> | undefined>();
      for (const [, data] of saves.mock.calls) {
        if (data.key === "sub:rule-first" && !firstWrites.has(data.id)) firstWrites.set(data.id, data.metadata);
      }
      expect(firstWrites.size).toBe(2);
      for (const metadata of firstWrites.values()) {
        expect(metadata).toMatchObject({ title: "First private", slackChannels: ["CFIRST"] });
      }
    } finally {
      saves.mockRestore();
    }
  });

  it("records the Slack channel on a team rule thread and its governing thread", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type: "team", id: "team-rules" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Rules", createdAt: 1 });
    const landed = await deliverToAssistantThread(deps, {
      ...base, owner, destination: { kind: "key", key: "sub:rule-private", title: "Private rule" },
      signal: signal("from a private channel"), dispatchId: "event:private-1", slackChannel: "CPRIV",
    });
    await deliverToAssistantThread(deps, {
      ...base, owner, destination: { kind: "key", key: "sub:rule-private", title: "Private rule" },
      signal: signal("again"), dispatchId: "event:private-2", slackChannel: "CPRIV",
    });
    const channels = async (sessionId: string, threadId: string) => {
      const thread = await engineHost.liveSession(sessionId)?.providers.store.getThread(sessionId, threadId);
      return thread?.metadata?.slackChannels;
    };
    expect(await channels(landed.sessionId, landed.threadId)).toEqual(["CPRIV"]);
    const [execution] = await testDb.appDb.select().from(assistantExecutions).where(eq(assistantExecutions.sessionId, landed.sessionId));
    const [root] = await testDb.appDb.select().from(assistants).where(eq(assistants.ownerId, owner.id));
    if (!execution || !root) throw new Error("expected a team execution");
    expect(await channels(root.sessionId, execution.governingThreadId)).toEqual(["CPRIV"]);
  });
});
