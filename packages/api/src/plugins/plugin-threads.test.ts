import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import {
  Engine,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ChildSpawner,
  type ChildStopper,
  type ValetPlugin,
} from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, childWatches, eventDeliveries } from "../schema/index.js";
import { answerFormat, awaitSubmission, buildPluginThreads, pluginChildSessionId, pluginThreadKey, stopPluginDeliveryChildren, type PluginThreadsDeps } from "./plugin-threads.js";

const reviewer: ValetPlugin = {
  name: "reviewer",
  version: "0.0.1",
  roles: [{ name: "verifier", content: "Check one claim against the code." }],
};

const owner = { type: "team" as const, id: "team-1" };
const thread = { sessionId: "sess-parent", threadId: "thr-parent", key: pluginThreadKey("reviewer", "acme/site#7") };

describe("pluginChildSessionId", () => {
  it("is fixed per plugin, thread and dispatch", () => {
    const a = pluginChildSessionId("reviewer", owner, thread.key, "verify:abc:0");
    expect(a).toMatch(/^child_plg_[0-9a-f]{32}$/);
    expect(pluginChildSessionId("reviewer", owner, thread.key, "verify:abc:0")).toBe(a);
    expect(pluginChildSessionId("reviewer", owner, thread.key, "verify:abc:1")).not.toBe(a);
    expect(pluginChildSessionId("other", owner, thread.key, "verify:abc:0")).not.toBe(a);
    // Two workspaces handling the same event never share a child.
    expect(pluginChildSessionId("reviewer", { type: "user", id: "u-1" }, thread.key, "verify:abc:0")).not.toBe(a);
  });
});

describe("PluginThreads.spawnChild", () => {
  async function setup() {
    const tdb = await freshTestPgDb();
    const spawner = vi.fn<ChildSpawner>(async (req) => ({ childSessionId: req.sessionId ?? "x", queueItemId: "q-1" }));
    const deps: PluginThreadsDeps = {
      db: tdb.appDb,
      engineStore: new InMemorySessionStore(),
      childSpawner: spawner,
      childStopper: vi.fn<ChildStopper>(async () => ({ stopped: 0 })),
      resolveThread: async () => ({ sessionId: thread.sessionId, threadId: thread.threadId }),
    };
    const threads = buildPluginThreads(deps, { plugin: reviewer, orgId: "org-1", owner, actorUserId: "user-1", deliveryId: "del-1" });
    return { tdb, spawner, threads };
  }

  it("spawns a silent, unattended child with the plugin's role and repo at a ref", async () => {
    const { spawner, threads } = await setup();
    const child = await threads.spawnChild(
      thread,
      { prompt: "check it", role: "verifier", repo: "acme/site", ref: "abc123", profile: "full", docker: true, resources: { cpu: 4 }, gitAccess: "read" },
      { dispatchId: "verify:abc:0" },
    );
    expect(child.childSessionId).toBe(pluginChildSessionId("reviewer", owner, thread.key, "verify:abc:0"));
    const [req, ctx] = spawner.mock.calls[0];
    expect(req).toMatchObject({
      prompt: "check it", role: "verifier", repo: "acme/site", branch: "abc123", sessionId: child.childSessionId,
      profile: "full", docker: true, resources: { cpu: 4 }, gitAccess: "read",
    });
    // No integration actions unless the plugin asks for them.
    expect(req.toolScope).toEqual({ actions: [] });
    expect(ctx).toMatchObject({ parentSessionId: "sess-parent", parentThreadId: "thr-parent", owner, unattendedWorkflow: true, reportToParent: false, pluginDeliveryId: "del-1" });
  });

  it("hands the plugin's prepare step to the child spawner", async () => {
    const { spawner, threads } = await setup();
    const prepare = async (_runner: unknown, prompt: string): Promise<string> => `${prompt} with context`;
    await threads.spawnChild(thread, { prompt: "review", repo: "acme/site", ref: "abc123", prepare }, { dispatchId: "review:abc" });
    expect(spawner.mock.calls[0][0].prepare).toBe(prepare);
  });

  it("returns the existing child on a retry of the same dispatch", async () => {
    const { tdb, spawner, threads } = await setup();
    // The retrying run's delivery is still live.
    await tdb.appDb.insert(eventDeliveries).values({ id: "del-1", eventId: "ev-1", subscriptionId: "sub-1", status: "failed", attempts: 1, nextAttemptAt: Date.now(), createdAt: Date.now() });
    const childSessionId = pluginChildSessionId("reviewer", owner, thread.key, "verify:abc:0");
    await tdb.appDb.insert(childWatches).values({
      childSessionId,
      queueItemId: "q-first",
      parentSessionId: thread.sessionId,
      parentThreadId: thread.threadId,
      actorUserId: "user-1",
      orgId: "org-1",
      createdAt: Date.now(),
      reportToParent: false,
    });
    const child = await threads.spawnChild(thread, { prompt: "check it" }, { dispatchId: "verify:abc:0" });
    expect(child).toEqual({ childSessionId, queueItemId: "q-first" });
    expect(spawner).not.toHaveBeenCalled();
  });

  it("refuses a child of another parent, and starts a replacement after an orphaned spawn", async () => {
    const { tdb, spawner, threads } = await setup();
    const baseId = pluginChildSessionId("reviewer", owner, thread.key, "d-other");
    await tdb.appDb.insert(childWatches).values({
      childSessionId: baseId, queueItemId: "q", parentSessionId: "someone-else", parentThreadId: "t",
      actorUserId: "user-1", orgId: "org-1", createdAt: Date.now(), reportToParent: false,
    });
    await expect(threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "d-other" })).rejects.toThrow("belongs to another thread");

    // A crash left a session row for the base id but no watch row.
    const orphan = pluginChildSessionId("reviewer", owner, thread.key, "d-orphan");
    await tdb.appDb.insert(agentSessions).values({
      id: orphan, userId: "user-1", orgId: "org-1", workspace: "/tmp", status: "active",
      ownerType: "team", ownerId: "team-1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const child = await threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "d-orphan" });
    expect(child.childSessionId).toBe(`${orphan}-r1`);
    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it("refuses an undeclared role, a ref without a repo, and another plugin's thread", async () => {
    const { threads } = await setup();
    await expect(threads.spawnChild(thread, { prompt: "p", role: "admin" }, { dispatchId: "d" })).rejects.toThrow("Role admin is not declared");
    await expect(threads.spawnChild(thread, { prompt: "p", ref: "main" }, { dispatchId: "d" })).rejects.toThrow("needs a repo");
    const foreign = { ...thread, key: pluginThreadKey("other", "k") };
    await expect(threads.spawnChild(foreign, { prompt: "p" }, { dispatchId: "d" })).rejects.toThrow("does not belong to plugin reviewer");
    await expect(threads.record(foreign, "a record", { dispatchId: "d" })).rejects.toThrow("does not belong to plugin reviewer");
  });
});

describe("PluginThreads child stopping", () => {
  async function setup() {
    const tdb = await freshTestPgDb();
    const spawner = vi.fn<ChildSpawner>(async (req) => ({ childSessionId: req.sessionId ?? "x", queueItemId: "q-1" }));
    const stopper = vi.fn<ChildStopper>(async () => ({ stopped: 1 }));
    const engineStore = new InMemorySessionStore();
    const deps: PluginThreadsDeps = {
      db: tdb.appDb,
      engineStore,
      childSpawner: spawner,
      childStopper: stopper,
      resolveThread: async () => ({ sessionId: thread.sessionId, threadId: thread.threadId }),
    };
    const cancel = new AbortController();
    const threads = buildPluginThreads(deps, { plugin: reviewer, orgId: "org-1", owner, actorUserId: "user-1", deliveryId: "del-new", cancelChildren: cancel.signal });
    return { tdb, spawner, stopper, engineStore, cancel, deps, threads };
  }

  async function seedParent(tdb: Awaited<ReturnType<typeof freshTestPgDb>>, engineStore: InMemorySessionStore, key: string, ownerId: string) {
    await tdb.appDb.insert(agentSessions).values({
      id: thread.sessionId, userId: "user-1", orgId: "org-1", workspace: "/tmp", status: "active",
      ownerType: "team", ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    vi.spyOn(engineStore, "getThread").mockImplementation(async (sessionId, threadId) =>
      sessionId === thread.sessionId && threadId === thread.threadId
        ? { id: threadId, sessionId, key, status: "active", queueMode: "followup", createdAt: Date.now(), updatedAt: Date.now() }
        : null);
  }

  async function seedDelivery(tdb: Awaited<ReturnType<typeof freshTestPgDb>>, id: string, status: "pending" | "skipped") {
    await tdb.appDb.insert(eventDeliveries).values({ id, eventId: "ev-1", subscriptionId: "sub-1", status, attempts: 1, nextAttemptAt: Date.now(), createdAt: Date.now() });
  }

  async function seedWatch(tdb: Awaited<ReturnType<typeof freshTestPgDb>>, childSessionId: string, pluginDeliveryId: string | null = null) {
    await tdb.appDb.insert(childWatches).values({
      childSessionId, queueItemId: "q-1", parentSessionId: thread.sessionId, parentThreadId: thread.threadId,
      actorUserId: "user-1", orgId: "org-1", createdAt: Date.now(), reportToParent: false, pluginDeliveryId,
    });
  }

  it("stops a child of one of this plugin's threads in this workspace", async () => {
    const { tdb, stopper, engineStore, threads } = await setup();
    await seedParent(tdb, engineStore, thread.key, owner.id);
    await seedWatch(tdb, "child_plg_a");
    expect(await threads.stopChild({ childSessionId: "child_plg_a", queueItemId: "q-1" })).toEqual({ stopped: 1 });
    expect(stopper).toHaveBeenCalledWith({ childSessionId: "child_plg_a" }, { parentSessionId: thread.sessionId, parentThreadId: thread.threadId });
  });

  it.each([
    ["another plugin's thread", pluginThreadKey("other", "k"), owner.id],
    ["another workspace's thread", thread.key, "team-2"],
  ])("refuses to stop a child of %s", async (_label, key, ownerId) => {
    const { tdb, stopper, engineStore, threads } = await setup();
    await seedParent(tdb, engineStore, key, ownerId);
    await seedWatch(tdb, "child_plg_a");
    await expect(threads.stopChild({ childSessionId: "child_plg_a", queueItemId: "q-1" })).rejects.toThrow("was not started by plugin reviewer");
    await expect(threads.stopChild({ childSessionId: "child_none", queueItemId: "q-1" })).rejects.toThrow("was not started by plugin reviewer");
    expect(stopper).not.toHaveBeenCalled();
  });

  it("takes over a reused child for this delivery, and after a cancel stops a late spawn and starts no more", async () => {
    const { tdb, stopper, spawner, cancel, threads } = await setup();
    await seedDelivery(tdb, "del-new", "pending");
    const found = pluginChildSessionId("reviewer", owner, thread.key, "found");
    await seedWatch(tdb, found, "del-old");
    await threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "found" });
    const [row] = await tdb.appDb.select({ d: childWatches.pluginDeliveryId }).from(childWatches).where(eq(childWatches.childSessionId, found));
    // Cancelling the delivery that first started it must not stop it now.
    expect(row?.d).toBe("del-new");

    // A spawn that lands after the cancel is stopped at once.
    let land: () => void = () => {};
    const landed = new Promise<void>((r) => { land = r; });
    spawner.mockImplementationOnce(async (req) => { await landed; return { childSessionId: req.sessionId ?? "x", queueItemId: "q-late" }; });
    const late = threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "racing" });
    await vi.waitFor(() => expect(spawner).toHaveBeenCalled());
    cancel.abort();
    land();
    const lateChild = await late;
    await vi.waitFor(() => expect(stopper).toHaveBeenCalledWith({ childSessionId: lateChild.childSessionId }, { parentSessionId: thread.sessionId, parentThreadId: thread.threadId }));
    await expect(threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "after" })).rejects.toThrow("This plugin run was cancelled");
  });

  it("never takes a child back once this run's delivery was superseded elsewhere", async () => {
    const { tdb, threads } = await setup();
    // Another process skipped this run's delivery; the run has not noticed yet.
    await seedDelivery(tdb, "del-new", "skipped");
    const shared = pluginChildSessionId("reviewer", owner, thread.key, "shared");
    await seedWatch(tdb, shared, "del-newer");
    await expect(threads.spawnChild(thread, { prompt: "p" }, { dispatchId: "shared" })).rejects.toMatchObject({ name: "AbortError" });
    const [row] = await tdb.appDb.select({ d: childWatches.pluginDeliveryId }).from(childWatches).where(eq(childWatches.childSessionId, shared));
    expect(row?.d).toBe("del-newer");
  });

  it("refuses to wait on a child or a reply outside this plugin's threads", async () => {
    const { tdb, engineStore, threads } = await setup();
    await seedParent(tdb, engineStore, pluginThreadKey("other", "k"), owner.id);
    await seedWatch(tdb, "child_plg_a");
    await expect(threads.awaitChild({ childSessionId: "child_plg_a", queueItemId: "q-1" })).rejects.toThrow("was not started by plugin reviewer");
    await expect(threads.awaitReply({ sessionId: thread.sessionId, threadId: thread.threadId, queueItemId: "q-x" }))
      .rejects.toThrow("is not in a thread of plugin reviewer");
  });
});

describe("stopPluginDeliveryChildren", () => {
  it("stops the unsettled children recorded against the deliveries, and only those", async () => {
    const tdb = await freshTestPgDb();
    const stopper = vi.fn<ChildStopper>(async () => ({ stopped: 1 }));
    const watch = (childSessionId: string, pluginDeliveryId: string | null, settled = false) => ({
      childSessionId, queueItemId: "q", parentSessionId: "p", parentThreadId: "t", actorUserId: "u", orgId: "o",
      createdAt: Date.now(), reportToParent: false, pluginDeliveryId, settled,
    });
    await tdb.appDb.insert(childWatches).values([
      watch("c-a", "del-a"), watch("c-a2", "del-a"), watch("c-done", "del-a", true), watch("c-b", "del-b"), watch("c-none", null),
    ]);
    expect(await stopPluginDeliveryChildren({ db: tdb.appDb, childStopper: stopper }, ["del-a"])).toBe(2);
    expect(stopper.mock.calls.map(([req]) => req.childSessionId).sort()).toEqual(["c-a", "c-a2"]);
    expect(stopper).toHaveBeenCalledWith({ childSessionId: "c-a" }, { childSessionId: "c-a", parentSessionId: "p", parentThreadId: "t" });
  });
});

describe("awaitSubmission", () => {
  it("ends with an AbortError when the handler run stops", async () => {
    const store = new InMemorySessionStore();
    const now = Date.now();
    vi.spyOn(store, "getQueueItem").mockResolvedValue({
      id: "q", threadId: "t", content: "work", status: "running", attemptCount: 1, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now,
    });
    const stop = new AbortController();
    // A long poll interval: the abort must end the wait, not the next poll.
    const waiting = awaitSubmission({ engineStore: store, pollMs: 60_000 }, { sessionId: "s", queueItemId: "q" }, { signal: stop.signal });
    setTimeout(() => stop.abort("plugin-line-off"), 20);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });


  it("reads a settled child's final message and validates it against the result schema", async () => {
    const faux = registerFauxProvider({ provider: "plugin-threads-test" });
    faux.setResponses([fauxAssistantMessage('Done.\n```json\n{"verdict": "confirmed", "line": 12}\n```')]);
    const store = new InMemorySessionStore();
    const engine = new Engine({
      providers: {
        store,
        stream: new InMemoryEventStream(),
        blobs: new InMemoryBlobStore(),
        credentials: new InMemoryCredentialStore(),
        sandboxProvider: new VirtualSandboxProvider(),
      },
    });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    const receipt = await session.prompt("verify the claim");
    await session.thread().awaitResult(receipt.queueItemId);

    const schema = Type.Object({ verdict: Type.String(), line: Type.Integer() });
    const result = await awaitSubmission({ engineStore: store, pollMs: 5 }, { sessionId: session.id, queueItemId: receipt.queueItemId }, { resultSchema: schema });
    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ verdict: "confirmed", line: 12 });

    const bad = await awaitSubmission({ engineStore: store, pollMs: 5 }, { sessionId: session.id, queueItemId: receipt.queueItemId },
      { resultSchema: Type.Object({ missing: Type.String() }) });
    expect(bad.output).toBeUndefined();
    expect(bad.error).toContain("did not match schema");
    await session.destroy();
    faux.unregister();
  });
});

describe("answerFormat", () => {
  it("asks for one json block that matches the schema", () => {
    const text = answerFormat(Type.Object({ conventions: Type.Array(Type.String()) }));
    expect(text).toContain("```json");
    expect(text).toContain('"conventions"');
  });
});
