import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { fauxAssistantMessage, fauxToolCall, Type, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgEventStream, PgSessionStore } from "@valet/store-postgres";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineHost } from "../engine/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { assistantExecutions, assistants, sessionThreads, teams, teamMembers, orgMembers, slackChannelPrivacy, users } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { ensureAssistantExecution } from "../assistants/service.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import { deliverToAssistantThread } from "./assistant-delivery.js";

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
    vi.restoreAllMocks();
    resetThreadAccessCache();
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

  it.each(["user", "team"] as const)("delivers new visible %s conversations once across retries", async type => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type, id: type === "user" ? USER : "subscription-team" };
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: USER, role: "member" });
    if (type === "team") {
      await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Subscriptions", createdAt: 1 });
      await testDb.appDb.insert(teamMembers).values({ teamId: owner.id, userId: USER, role: "member" });
    }
    const args = { orgId: ORG, owner, actorUserId: USER, destinationUserId: USER,
      subscriptionThread: { mode: "new" as const }, threadKey: "web:event:visible-retry",
      signal: { kind: "signal" as const, signalType: "github.issues.opened", body: "Subscription event" },
      dispatchId: "event:visible-retry", mismatchReason: "test" };
    await deliverToAssistantThread(deps, args);
    engineHost.evictAll();
    await deliverToAssistantThread(deps, args);
    const result = await testDb.appDb.execute(sql`SELECT q.session_id, t.key FROM engine_queue_items q
      JOIN engine_threads t ON t.id = q.thread_id AND t.session_id = q.session_id WHERE q.dispatch_id = 'event:visible-retry'`) as { rows: Array<{ session_id: string; key: string }> };
    expect(result.rows).toEqual([{ session_id: expect.any(String), key: "web:event:visible-retry" }]);
  });

  it.each(["user", "team"] as const)("rechecks %s destinations before delivery and never falls back after revocation", async type => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type, id: type === "user" ? USER : "subscription-existing-team" };
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: USER, role: "member" });
    if (type === "team") {
      await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Subscriptions", createdAt: 1 });
      await testDb.appDb.insert(teamMembers).values({ teamId: owner.id, userId: USER, role: "member" });
    }
    const { session } = await ensureAssistantExecution(deps, owner, { actorUserId: USER, orgId: ORG }, "web:existing-target");
    const thread = await session.createThread("web:existing-target");
    await thread.pause();
    const target = { sessionId: session.id, threadId: thread.id };
    const args = { orgId: ORG, owner, actorUserId: USER, destinationUserId: USER,
      subscriptionThread: { mode: "existing" as const, ...target }, target,
      threadKey: "subscription:existing-target", signal: channelSignal("selected conversation"),
      dispatchId: "event:existing-first", mismatchReason: "test" };
    await deliverToAssistantThread(deps, args);
    await testDb.appDb.insert(sessionThreads).values({ id: thread.id, sessionId: session.id, createdAt: 1, archivedAt: 1 });
    await expect(deliverToAssistantThread(deps, { ...args, dispatchId: "event:existing-archived" })).rejects.toThrow();
    await testDb.appDb.update(sessionThreads).set({ archivedAt: null }).where(eq(sessionThreads.id, thread.id));
    await testDb.appDb.delete(orgMembers).where(eq(orgMembers.userId, USER));
    await expect(deliverToAssistantThread(deps, { ...args, dispatchId: "event:existing-revoked" })).rejects.toThrow("Choose an active conversation");
    expect((await session.providers.store.listUnsettledSubmissions(session.id)).map(item => item.dispatchId)).toEqual(["event:existing-first"]);
    // An already admitted event remains recoverable after access changes.
    await expect(deliverToAssistantThread(deps, args)).resolves.toBeUndefined();
  });

  it.each([
    { type: "team" as const, privateChannel: true, allowed: false },
    { type: "team" as const, privateChannel: false, allowed: true },
    { type: "user" as const, privateChannel: true, allowed: true },
  ])("checks the $type Slack source audience after admission recovery (private=$privateChannel)", async ({ type, privateChannel, allowed }) => {
    const db = testDb.appDb;
    const deps = { db, engineHost };
    const owner = { type, id: type === "user" ? USER : "source-team" };
    await db.insert(orgMembers).values({ orgId: ORG, userId: USER, role: "member" });
    if (type === "team") {
      await db.insert(teams).values({ id: owner.id, orgId: ORG, name: "Sources", createdAt: 1 });
      await db.insert(teamMembers).values({ teamId: owner.id, userId: USER, role: "member" });
    }
    await db.insert(slackChannelPrivacy).values({ orgId: ORG, channelId: "C-source", isPrivate: privateChannel, checkedAt: Date.now() });
    const args = { orgId: ORG, owner, actorUserId: USER, destinationUserId: USER,
      subscriptionThread: { mode: "new" as const }, subscriptionSourceKey: "slack-events:C-source",
      threadKey: "web:event:source-audience", signal: channelSignal("Source event"), dispatchId: "event:source-audience", mismatchReason: "test" };
    if (!allowed) {
      await expect(deliverToAssistantThread(deps, args)).rejects.toThrow("channel routing");
      const rows = await db.execute(sql`SELECT id FROM engine_queue_items WHERE dispatch_id = 'event:source-audience'`) as { rows: unknown[] };
      expect(rows.rows).toHaveLength(0);
    } else {
      await deliverToAssistantThread(deps, args);
      await db.update(slackChannelPrivacy).set({ isPrivate: true }).where(eq(slackChannelPrivacy.orgId, ORG));
      // Retrying acknowledges the original admission even after its source changes.
      await expect(deliverToAssistantThread(deps, args)).resolves.toBeUndefined();
      const rows = await db.execute(sql`SELECT id FROM engine_queue_items WHERE dispatch_id = 'event:source-audience'`) as { rows: unknown[] };
      expect(rows.rows).toHaveLength(1);
    }
  });

  it("refreshes a stale public Slack source before admitting a new delivery", async () => {
    const db = testDb.appDb;
    const owner = { type: "team", id: "stale-source-team" } as const;
    await db.insert(orgMembers).values({ orgId: ORG, userId: USER, role: "member" });
    await db.insert(teams).values({ id: owner.id, orgId: ORG, name: "Sources", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: owner.id, userId: USER, role: "member" });
    await db.insert(slackChannelPrivacy).values({ orgId: ORG, channelId: "C-stale-source", isPrivate: false, checkedAt: 1 });
    const engineCredentials = new PgCredentialStore(testDb.pgdb, deriveSecretKey("test-key"));
    await engineCredentials.save({ type: "org", id: ORG }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "slack.com") return realFetch(input, init);
      return new Response(JSON.stringify({ ok: true, channel: { name: "source", is_private: false } }), { headers: { "content-type": "application/json" } });
    });
    await deliverToAssistantThread({ db, engineHost, engineCredentials }, {
      orgId: ORG, owner, actorUserId: USER, destinationUserId: USER, subscriptionThread: { mode: "new" },
      subscriptionSourceKey: "slack-events:C-stale-source", threadKey: "web:event:stale-source",
      signal: channelSignal("Public source event"), dispatchId: "event:stale-source", mismatchReason: "test",
    });
    const [privacy] = await db.select().from(slackChannelPrivacy).where(eq(slackChannelPrivacy.channelId, "C-stale-source"));
    expect(privacy?.checkedAt).toBeGreaterThan(1);
  });

  it("creates a shared runtime with a machine actor and persists that identity", async () => {
    const deps = { db: testDb.appDb, engineHost };
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: `org:${ORG}`, threadKey: "events",
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
        orgId: ORG, owner: OWNER, actorUserId: actor, threadKey,
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
        orgId: ORG, owner: OWNER, actorUserId: USER, threadKey: "events",
        signal: { kind: "signal", signalType: "test", body: dispatchId },
        dispatchId, presence, mismatchReason: "test",
      });
      const result = await testDb.appDb.execute(sql`SELECT metadata FROM engine_queue_items WHERE dispatch_id = ${dispatchId}`) as { rows: Array<{ metadata: unknown }> };
      const metadata = result.rows[0]?.metadata;
      expect(typeof metadata === "string" ? JSON.parse(metadata) : metadata).toEqual(presence ? { presence } : null);
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
      threadKey: "slack:C1:1.2", signal: channelSignal("first"),
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
      threadKey: "slack:C1:next", signal: channelSignal("next"),
      dispatchId: "model-next", mismatchReason: "event_target_mismatch",
    });
    expect((await restored.threadByKey("slack:C1:next"))?.modelId()).toBe("s");
    expect((await restored.threadByKey("slack:C1:next"))?.toThreadData().reasoning).toBe("off");
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
        orgId: ORG, owner, actorUserId: USER, threadKey: "slack-events:C1", signal,
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

  it("recovers the admitted event before a new PR target and verifies its original content", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
    const thread = session.thread("events");
    await thread.pause();
    const signal = channelSignal("review the change");
    const seeded = { ...signal, body: `Conversation so far in this thread:\nEarlier history\n\n---\n\n${signal.body}` };
    const admitted = await thread.submitPrompt(seeded, { dispatchId: "event:pr-cutover" });
    const args = { orgId: ORG, owner: OWNER, actorUserId: USER, threadKey: "web:pr-origin",
      target: { sessionId: "new-pr-runtime", threadId: "new-pr-thread" }, signal,
      dispatchId: "event:pr-cutover", mismatchReason: "test" };
    await expect(deliverToAssistantThread(deps, args)).resolves.toBeUndefined();
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
    const args = { orgId: ORG, owner, actorUserId: USER, threadKey: key,
      target: { sessionId: session.id, threadId: thread.id }, signal: channelSignal("Review feedback"),
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
    const target = { sessionId: session.id, threadId: empty.id };
    const first = deliverToAssistantThread({ ...deps, fetchThreadContext }, { ...args, target, dispatchId: "queued-first" });
    await waiting;
    const second = deliverToAssistantThread(deps, { ...args, target, dispatchId: "queued-second" });
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
        threadKey: "slack:C1:1.2",
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
        threadKey: "slack:C1:1.2",
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
        threadKey: "slack:C1:1.2",
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
          threadKey: "slack:C1:1.2",
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
          threadKey: "slack:C1:1.2",
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

  it("delivers into the owner's singleton and persists the initiating actor", async () => {
    const deps = { db: testDb.appDb, engineHost };
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, threadKey: "events",
      signal: signal("go"), dispatchId: "d1", mismatchReason: "event_target_mismatch",
    });
    expect(await firstUserEntry(deps, "events")).toMatchObject({ content: "go", author: { id: USER } });
    const rows = await testDb.appDb.select().from(assistants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerType: OWNER.type, ownerId: OWNER.id });
  });
});
