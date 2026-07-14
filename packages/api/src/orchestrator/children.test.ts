/**
 * Child spawner limits + durable ChildWatcher (Phase 4 Task 8, decisions
 * 10/11/21). Unit-level over a real bootTestApi() stack — no LLM turn is
 * ever required to pass: the watcher test hand-settles the child's
 * submission via the engine store directly, and the parent thread is paused
 * so the admitted `child.settled` signal stays observable in the queue.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import type { QueueItem, SignalContent } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  buildChildSpawner,
  ChildWatcher,
  ChildLimitError,
  classifyWatcherError,
  type ChildrenDeps,
} from "./children.js";
import { MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR, ORG_ACTIVE_SESSION_CEILING } from "./limits.js";
import { agentSessions, childWatches, eventDropLog } from "../schema/index.js";
import { PendingCapError, ValidationError as EngineValidationError } from "@valet/engine";
import { SignalEdgeDeniedError } from "./signals.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function childrenDeps(a: TestApi, overrides: Partial<ChildrenDeps> = {}): ChildrenDeps {
  return {
    db: a.providers.db,
    engineHost: a.providers.engineHost,
    engineStore: a.providers.engineStore,
    workspaceRoot: mkdtempSync(join(tmpdir(), "valet-children-test-")),
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

function queuedItem(id: string, threadId: string, prompt: string): QueueItem {
  const now = Date.now();
  return {
    id,
    threadId,
    content: prompt,
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
}

describe("buildChildSpawner", () => {
  it("spawns a child session with inherited owner, parent linkage, mirror row, watch row — and NO childSpawner in its toolConfig", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);

    const parent = await api.providers.engineHost.sessionFor("parent-spawn", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    const owner = { type: "team" as const, id: "team-x" };

    const result = await spawner(
      { prompt: "do the thing", title: "The Thing" },
      {
        parentSessionId: "parent-spawn",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        owner,
      },
    );
    expect(result.childSessionId).toMatch(/^child_/);
    expect(result.queueItemId).toBeTruthy();

    const child = api.providers.engineHost.liveSession(result.childSessionId);
    expect(child).not.toBeNull();
    expect(child?.options.purpose).toBe("child");
    expect(child?.options.parentSessionId).toBe("parent-spawn");
    expect(child?.options.parentThreadId).toBe(parentThread.id);
    expect(child?.owner).toEqual(owner);
    // Depth limit 1 (decision 10): the child gets no spawner — `task`
    // inside it falls through to [task_unavailable].
    expect(child?.options.toolConfig?.childSpawner).toBeUndefined();

    // Durable parent linkage on the engine row (what the edge ACL reads).
    const childData = await api.providers.engineStore.getSession(result.childSessionId);
    expect(childData?.parentSessionId).toBe("parent-spawn");

    const appRow = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.childSessionId))
      .get();
    expect(appRow).toBeDefined();
    expect(appRow?.title).toBe("The Thing");
    expect(appRow?.ownerType).toBe("team");
    expect(appRow?.ownerId).toBe("team-x");

    const watchRow = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, result.childSessionId))
      .get();
    expect(watchRow).toBeDefined();
    expect(watchRow?.queueItemId).toBe(result.queueItemId);
    expect(watchRow?.parentSessionId).toBe("parent-spawn");
    expect(watchRow?.parentThreadId).toBe(parentThread.id);
  });

  it("rejects the 11th active child with [child_cap] naming the running children, and drop-logs", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-cap", {
      userId: "local-user",
      orgId: "org-cap-test",
      workspace: "/tmp",
    });

    const now = Date.now();
    const runningIds: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR; i++) {
      const id = `child_running_${i}`;
      runningIds.push(id);
      await api.providers.db
        .insert(childWatches)
        .values({
          childSessionId: id,
          queueItemId: `qi-${i}`,
          parentSessionId: "parent-cap",
          parentThreadId: "th-x",
          actorUserId: "local-user",
          orgId: "org-cap-test",
          settled: 0,
          createdAt: now,
        })
        .run();
    }

    const attempt = spawner(
      { prompt: "one too many" },
      {
        parentSessionId: "parent-cap",
        parentThreadId: "th-x",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    await expect(attempt).rejects.toThrow(ChildLimitError);
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChildLimitError);
    if (err instanceof ChildLimitError) {
      expect(err.code).toBe("child_cap");
      expect(err.message.startsWith("[child_cap]")).toBe(true);
      for (const id of runningIds) expect(err.message).toContain(id);
    }

    const drops = await api.providers.db
      .select()
      .from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "org-cap-test"), eq(eventDropLog.reason, "child_cap")))
      .all();
    expect(drops).toHaveLength(1);
  });

  it("rejects a spawn at the org active-session ceiling with [org_ceiling], and drop-logs", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-ceiling", {
      userId: "local-user",
      orgId: "org-ceiling-test",
      workspace: "/tmp",
    });

    const now = Date.now();
    for (let i = 0; i < ORG_ACTIVE_SESSION_CEILING; i++) {
      await api.providers.db
        .insert(agentSessions)
        .values({
          id: `s_ceiling_${i}`,
          userId: "local-user",
          orgId: "org-ceiling-test",
          workspace: "/tmp",
          status: "active",
          ownerType: "user",
          ownerId: "local-user",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const attempt = spawner(
      { prompt: "over the ceiling" },
      {
        parentSessionId: "parent-ceiling",
        parentThreadId: "th-y",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChildLimitError);
    if (err instanceof ChildLimitError) {
      expect(err.code).toBe("org_ceiling");
      expect(err.message.startsWith("[org_ceiling]")).toBe(true);
    }

    const drops = await api.providers.db
      .select()
      .from(eventDropLog)
      .where(and(eq(eventDropLog.orgId, "org-ceiling-test"), eq(eventDropLog.reason, "org_ceiling")))
      .all();
    expect(drops).toHaveLength(1);
  });
});

describe("ChildWatcher", () => {
  it("delivers exactly ONE child.settled to the spawning parent thread with the deterministic dispatchId, even when armed twice", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-w", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    // Pause the parent so the admitted signal submission stays queued (and
    // thus observable via listUnsettledSubmissions) instead of being claimed
    // by a doomed no-API-key turn.
    await parent.pause();

    const child = await engineHost.childSessionFor("child-w", {
      parentSessionId: "parent-w",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");

    // Hand-settle a submission on the child thread via the store directly —
    // the ungated stand-in for a completed child run.
    const itemId = "qi-settled-1";
    await engineStore.admitSubmission("child-w", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-w", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-w",
      queueItemId: itemId,
      parentSessionId: "parent-w",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db
      .insert(childWatches)
      .values({ ...watch, settled: 0, createdAt: Date.now() })
      .run();

    // Double-fire: direct arm AND a rearm() pass over the unsettled row.
    watcher.arm(watch);
    await watcher.rearm();

    await waitFor(async () => {
      const row = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-w")).get();
      return row?.settled === 1;
    });
    // Let any in-flight second admission finish before counting.
    await new Promise((r) => setTimeout(r, 100));

    const unsettled = await engineStore.listUnsettledSubmissions("parent-w");
    const settledSignals = unsettled.filter(
      (i) =>
        typeof i.content === "object" &&
        i.content !== null &&
        "kind" in i.content &&
        i.content.kind === "signal" &&
        (i.content as SignalContent).signalType === "child.settled",
    );
    expect(settledSignals).toHaveLength(1);
    // Deterministic dispatchId, namespaced by the engine with the stamped
    // sender session id — this is what makes double-fires idempotent.
    expect(settledSignals[0]?.dispatchId).toBe(`child-w:settled:child-w:${itemId}`);
    expect(settledSignals[0]?.threadId).toBe(parentThread.id);
    const content = settledSignals[0]?.content as SignalContent;
    expect(content.attributes?.child_session_id).toBe("child-w");
    expect(content.attributes?.outcome).toBe("completed");
  });

  it("leaves an un-diagnosable (retryable) failure UNSETTLED after exhausting in-process retries, relying on rearm() as the backstop", async () => {
    api = await bootTestApi();
    // Small budget so the test doesn't wait on the 30s production default.
    const deps = childrenDeps(api, { retryDelayMs: 15, maxRetryAttempts: 2 });
    const watcher = new ChildWatcher(deps);
    const { db } = api.providers;

    // A watch whose child session doesn't exist — every attempt throws a
    // generic (non-SignalEdgeDeniedError, non-ValidationError) Error, which
    // `classifyWatcherError` treats as retryable, not a permanent denial
    // (decision 20): the row must stay unsettled rather than losing the
    // signal.
    const watch = {
      childSessionId: "child-ghost",
      queueItemId: "qi-ghost",
      parentSessionId: "parent-ghost",
      parentThreadId: "th-ghost",
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db
      .insert(childWatches)
      .values({ ...watch, settled: 0, createdAt: Date.now() })
      .run();

    watcher.arm(watch);

    // Let both in-process attempts (and the retry delay between them) run out.
    await new Promise((r) => setTimeout(r, 150));

    const row = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-ghost")).get();
    expect(row?.settled).toBe(0);

    // Not a real edge denial, so no edge_denied row — and nothing was
    // actually dropped (the row is still eligible for `rearm()`).
    const drops = await db
      .select()
      .from(eventDropLog)
      .where(eq(eventDropLog.conversationKey, "qi-ghost"))
      .all();
    expect(drops).toHaveLength(0);
  });

  it("delivers exactly once after deferring on a full parent pending cap: NOT settled + pending_cap drop-log while capped, settles once the thread drains and rearm() re-observes", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api, { retryDelayMs: 20, maxRetryAttempts: 2 });
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-cap-watch", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    // Pause the parent so nothing claims/drains the filler items on its own.
    await parent.pause();

    // Fill the thread's pending cap (20, MAX_PENDING_PER_THREAD) directly
    // via the store — admission-time, no LLM turn required.
    for (let i = 0; i < 20; i++) {
      await engineStore.admitSubmission(
        "parent-cap-watch",
        parentThread.id,
        queuedItem(`cap-filler-${i}`, parentThread.id, "filler"),
      );
    }

    const child = await engineHost.childSessionFor("child-cap-watch", {
      parentSessionId: "parent-cap-watch",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    const itemId = "qi-cap-settled";
    await engineStore.admitSubmission("child-cap-watch", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-cap-watch", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-cap-watch",
      queueItemId: itemId,
      parentSessionId: "parent-cap-watch",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db
      .insert(childWatches)
      .values({ ...watch, settled: 0, createdAt: Date.now() })
      .run();

    watcher.arm(watch);

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(eventDropLog)
        .where(and(eq(eventDropLog.reason, "pending_cap"), eq(eventDropLog.conversationKey, itemId)))
        .all();
      return rows.length > 0;
    });

    // Give the in-process retries a chance to exhaust; the watch must still
    // NOT be settled — the settlement is not lost, just deferred.
    await new Promise((r) => setTimeout(r, 150));
    const capped = await db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-cap-watch"))
      .get();
    expect(capped?.settled).toBe(0);

    // Drain the parent thread and re-arm (the boot backstop) — the signal
    // must now be delivered exactly once.
    for (let i = 0; i < 20; i++) {
      await engineStore.settleUnclaimed("parent-cap-watch", parentThread.id, `cap-filler-${i}`, {
        outcome: "completed",
      });
    }
    await watcher.rearm();

    await waitFor(async () => {
      const row = await db
        .select()
        .from(childWatches)
        .where(eq(childWatches.childSessionId, "child-cap-watch"))
        .get();
      return row?.settled === 1;
    });
    await new Promise((r) => setTimeout(r, 100));

    const unsettled = await engineStore.listUnsettledSubmissions("parent-cap-watch");
    const settledSignals = unsettled.filter(
      (i) =>
        typeof i.content === "object" &&
        i.content !== null &&
        "kind" in i.content &&
        i.content.kind === "signal" &&
        (i.content as SignalContent).signalType === "child.settled" &&
        (i.content as SignalContent).attributes?.child_session_id === "child-cap-watch",
    );
    expect(settledSignals).toHaveLength(1);
  });

  it("marks the watch settled with an edge_denied drop-log entry on a REAL edge denial (parent session missing)", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const child = await engineHost.childSessionFor("child-real-denial", {
      parentSessionId: "parent-does-not-exist",
      parentThreadId: "th-does-not-exist",
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    const itemId = "qi-real-denial";
    await engineStore.admitSubmission("child-real-denial", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-real-denial", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-real-denial",
      queueItemId: itemId,
      // Never created — `authorizeEdge` throws a real SignalEdgeDeniedError.
      parentSessionId: "parent-does-not-exist",
      parentThreadId: "th-does-not-exist",
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db
      .insert(childWatches)
      .values({ ...watch, settled: 0, createdAt: Date.now() })
      .run();

    watcher.arm(watch);

    await waitFor(async () => {
      const row = await db
        .select()
        .from(childWatches)
        .where(eq(childWatches.childSessionId, "child-real-denial"))
        .get();
      return row?.settled === 1;
    });

    const dispatchId = `settled:child-real-denial:${itemId}`;
    const drops = await db
      .select()
      .from(eventDropLog)
      .where(and(eq(eventDropLog.reason, "edge_denied"), eq(eventDropLog.conversationKey, dispatchId)))
      .all();
    // Exactly one row — `authorizeEdge` logs it; `ChildWatcher` must not
    // double-log an already-logged permanent denial.
    expect(drops).toHaveLength(1);
    expect(drops[0]?.detail).toContain("parent-does-not-exist");
  });
});

describe("classifyWatcherError", () => {
  it("classifies PendingCapError as retryable, pendingCap: true", () => {
    expect(classifyWatcherError(new PendingCapError("th-x", 20))).toEqual({
      kind: "retryable",
      pendingCap: true,
    });
  });

  it("classifies a generic Error as retryable, pendingCap: false", () => {
    expect(classifyWatcherError(new Error("session not found"))).toEqual({
      kind: "retryable",
      pendingCap: false,
    });
  });

  it("classifies SignalEdgeDeniedError as permanent, alreadyLogged: true", () => {
    expect(classifyWatcherError(new SignalEdgeDeniedError("a", "b", "no authorized edge"))).toEqual({
      kind: "permanent",
      alreadyLogged: true,
    });
  });

  it("classifies a hop-budget ValidationError as permanent, alreadyLogged: true", () => {
    expect(classifyWatcherError(new EngineValidationError("hop budget exceeded (max 8)"))).toEqual({
      kind: "permanent",
      alreadyLogged: true,
    });
  });

  it("classifies a non-hop-budget ValidationError as permanent, alreadyLogged: false (needs its own drop-log)", () => {
    expect(classifyWatcherError(new EngineValidationError("fromOffset must be a safe-integer decimal string"))).toEqual({
      kind: "permanent",
      alreadyLogged: false,
    });
  });
});
