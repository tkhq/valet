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
import type {
  QueueItem,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
  SignalContent,
} from "@valet/engine";
import { VirtualSandbox } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  buildChildReader,
  buildChildSender,
  buildChildFilePusher,
  buildChildSpawner,
  buildChildStatusReader,
  ChildWatcher,
  ChildLimitError,
  classifyWatcherError,
  type ChildrenDeps,
  resultBody,
  parseTaskRepo,
  CHILD_RESULT_MAX_CHARS,
} from "./children.js";
import { MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR, ORG_ACTIVE_SESSION_CEILING } from "./limits.js";
import { agentSessions, bakes, childWatches, eventDropLog, imageSources, sandboxTokens, sessionRepos, sessionStagedFiles } from "../schema/index.js";
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
    prebuildService: a.providers.prebuildService,
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


/** Narrows `SessionOptions.sandbox` to create-opts — the live `Sandbox`
 * handle carries an `id`; plain create-opts do not. */
function asCreateOpts(sb: Sandbox | SandboxCreateOpts | undefined): SandboxCreateOpts | undefined {
  return sb && !("id" in sb) ? sb : undefined;
}

/** Isolated + customImage provider backed by VirtualSandbox — enough for
 * `buildSpecProvider` to wire per-profile image resolution for a child. */
function makeImageRecordingProvider(): SandboxProvider {
  const sandboxes = new Map<string, VirtualSandbox>();
  let nextId = 1;
  return {
    backend: "recording-image",
    capabilities(): SandboxCapabilities {
      return {
        snapshot: "none",
        persistentWorkspace: false,
        tunnels: false,
        warmPool: false,
        hibernation: false,
        isolated: true,
        customImage: true,
      };
    },
    async create(): Promise<Sandbox> {
      const id = `img-${nextId++}`;
      const sb = new VirtualSandbox(id);
      sandboxes.set(id, sb);
      return sb;
    },
    async restore(id: string): Promise<Sandbox> {
      const sb = sandboxes.get(id);
      if (!sb) throw new Error(`not found: ${id}`);
      return sb;
    },
    async destroy(id: string): Promise<void> {
      sandboxes.delete(id);
    },
    async status(id: string): Promise<SandboxStatus> {
      return sandboxes.has(id)
        ? { id, state: "ready", startedAt: Date.now() }
        : { id, state: "released" };
    },
  };
}

/** Seeds a kind='base' image source with one pushed bake for `profile`. */
async function seedBaseSourceWithBake(
  a: TestApi,
  id: string,
  profile: "headless" | "full",
  bakeRef: string,
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(imageSources).values({
    id,
    orgId: "local-org",
    kind: "base",
    parentId: null,
    name: `default-${profile}`,
    externalRef: null,
    pullSecretName: null,
    setupCommands: [],
    profile,
    repoHost: null,
    repoFullName: null,
    cloneUrl: null,
    schedule: "nightly",
    enabled: true,
    lastBoundAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await a.providers.db.insert(bakes).values({
    id: `${id}-bake`,
    sourceId: id,
    identityHash: "",
    commitSha: null,
    imageRef: bakeRef,
    status: "pushed",
    builderBackend: "docker",
    recipe: { recipe: [], setup: [], image: undefined },
    error: null,
    logTail: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  });
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

    const appRows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.childSessionId))
      .limit(1);
    const appRow = appRows[0];
    expect(appRow).toBeDefined();
    expect(appRow?.title).toBe("The Thing");
    expect(appRow?.ownerType).toBe("team");
    expect(appRow?.ownerId).toBe("team-x");

    const watchRows = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, result.childSessionId))
      .limit(1);
    const watchRow = watchRows[0];
    expect(watchRow).toBeDefined();
    expect(watchRow?.queueItemId).toBe(result.queueItemId);
    expect(watchRow?.parentSessionId).toBe("parent-spawn");
    expect(watchRow?.parentThreadId).toBe(parentThread.id);
  });

  it("threads profile/docker to the child's sandbox options and persists them on the row (defaults: headless, no docker)", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    const parent = await api.providers.engineHost.sessionFor("parent-docker", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    const ctx = {
      parentSessionId: "parent-docker",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      owner: { type: "user" as const, id: "local-user" },
    };

    const dockerChild = await spawner({ prompt: "test dind", profile: "full", docker: true }, ctx);
    const built = api.providers.engineHost.liveSession(dockerChild.childSessionId);
    expect(asCreateOpts(built?.options.sandbox)?.profile).toBe("full");
    expect(asCreateOpts(built?.options.sandbox)?.docker).toBe(true);
    const dockerRows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, dockerChild.childSessionId))
      .limit(1);
    expect(dockerRows[0]?.profile).toBe("full");
    expect(dockerRows[0]?.docker).toBe(true);

    // Omitted flags keep today's defaults — headless, docker off.
    const plainChild = await spawner({ prompt: "plain" }, ctx);
    const plainBuilt = api.providers.engineHost.liveSession(plainChild.childSessionId);
    expect(asCreateOpts(plainBuilt?.options.sandbox)?.profile).toBe("headless");
    expect(asCreateOpts(plainBuilt?.options.sandbox)?.docker).toBeUndefined();
    const plainRows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, plainChild.childSessionId))
      .limit(1);
    expect(plainRows[0]?.profile).toBe("headless");
    expect(plainRows[0]?.docker).toBe(false);
  });

  it("full-profile child resolves its sandbox image with the child's profile — not the headless default", async () => {
    // Isolated + customImage provider so buildSpecProvider wires image
    // resolution (resolveBaseImage consults the org's per-profile base bakes).
    const provider = makeImageRecordingProvider();
    api = await bootTestApi({
      sandboxProvider: provider,
      defaultImages: { headless: "stock-headless:img", full: "stock-full:img" },
    });
    // Pushed base bakes for BOTH profiles: a child meta that drops the
    // profile resolves the headless bake; the correct meta resolves full.
    await seedBaseSourceWithBake(api, "cb-h", "headless", "reg/cb-h/base:1");
    await seedBaseSourceWithBake(api, "cb-f", "full", "reg/cb-f/base:1");

    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const parent = await api.providers.engineHost.sessionFor("parent-image", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const result = await spawner(
      { prompt: "dind verification", profile: "full", docker: true },
      {
        parentSessionId: "parent-image",
        parentThreadId: parent.thread("web:default").id,
        actorUserId: "local-user",
        owner: { type: "user" as const, id: "local-user" },
      },
    );

    const built = api.providers.engineHost.liveSession(result.childSessionId);
    const spec = await built?.options.specProvider?.();
    expect(spec).toBeDefined();
    expect(spec?.image).toBe("reg/cb-f/base:1");
  });

  it("child_send after a cache eviction (api restart) rebuilds the child with its persisted profile/docker", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const sender = buildChildSender(deps, watcher);

    const parent = await api.providers.engineHost.sessionFor("parent-rebuild", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const ctx = {
      parentSessionId: "parent-rebuild",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      owner: { type: "user" as const, id: "local-user" },
    };
    const spawned = await spawner({ prompt: "dind work", profile: "full", docker: true }, ctx);

    // Simulate an api restart: the cached session dies; the row survives.
    api.providers.engineHost.evictAll();
    expect(api.providers.engineHost.liveSession(spawned.childSessionId)).toBeNull();

    await sender({ childSessionId: spawned.childSessionId, message: "continue" }, ctx);

    const rebuilt = api.providers.engineHost.liveSession(spawned.childSessionId);
    expect(rebuilt).not.toBeNull();
    expect(asCreateOpts(rebuilt?.options.sandbox)?.profile).toBe("full");
    expect(asCreateOpts(rebuilt?.options.sandbox)?.docker).toBe(true);
  });

  it("binds req.repo: session_repos row, clone prep wired, repo image source upserted", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    const parent = await api.providers.engineHost.sessionFor("parent-repo", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const result = await spawner(
      { prompt: "explore the repo", repo: "tkhq/sdk", branch: "main" },
      {
        parentSessionId: "parent-repo",
        parentThreadId: parent.thread("web:default").id,
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // The binding row mirrors what the REST create route writes.
    const rows = await api.providers.db
      .select()
      .from(sessionRepos)
      .where(eq(sessionRepos.sessionId, result.childSessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      host: "github",
      fullName: "tkhq/sdk",
      cloneUrl: "https://github.com/tkhq/sdk.git",
      ref: "main",
      auth: "auto",
      position: 0,
    });
    expect(rows[0]?.targetDir).toBeTruthy();

    // The child session's build saw the binding: clone prep is wired.
    const child = api.providers.engineHost.liveSession(result.childSessionId);
    expect(child?.options.specProvider).toBeDefined();

    // Zero-config generation (spec decision 13) fires for children too —
    // the image source row appears even though no builder is wired here.
    await waitFor(async () => {
      const sources = await api!.providers.db
        .select()
        .from(imageSources)
        .where(and(eq(imageSources.orgId, "local-org"), eq(imageSources.repoFullName, "tkhq/sdk")));
      return sources.length === 1;
    });
  });

  it("spawns without repo: no session_repos row, no clone prep", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    const parent = await api.providers.engineHost.sessionFor("parent-norepo", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const result = await spawner(
      { prompt: "no repo here" },
      {
        parentSessionId: "parent-norepo",
        parentThreadId: parent.thread("web:default").id,
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    const rows = await api.providers.db
      .select()
      .from(sessionRepos)
      .where(eq(sessionRepos.sessionId, result.childSessionId));
    expect(rows).toHaveLength(0);
  });

  it("rejects an unparseable repo before creating anything", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    const parent = await api.providers.engineHost.sessionFor("parent-badrepo", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    await expect(
      spawner(
        { prompt: "x", repo: "not a repo!!" },
        {
          parentSessionId: "parent-badrepo",
          parentThreadId: parent.thread("web:default").id,
          actorUserId: "local-user",
          owner: { type: "user", id: "local-user" },
        },
      ),
    ).rejects.toThrow(/owner\/repo/);
    const watches = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.parentSessionId, "parent-badrepo"));
    expect(watches).toHaveLength(0);
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
          settled: false,
          createdAt: now,
        });
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
      .where(and(eq(eventDropLog.orgId, "org-cap-test"), eq(eventDropLog.reason, "child_cap")));
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
        });
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
      .where(and(eq(eventDropLog.orgId, "org-ceiling-test"), eq(eventDropLog.reason, "org_ceiling")));
    expect(drops).toHaveLength(1);
  });

  it("releases a settled child's org-ceiling slot: an org full of finished children can spawn again", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-release", {
      userId: "local-user",
      orgId: "org-release-test",
      workspace: "/tmp",
    });

    // Fill the org to the ceiling entirely with SETTLED children. Each child
    // keeps its agent_sessions row after settlement (spawn inserts it; nothing
    // deletes it) — finished work must not consume capacity forever.
    const now = Date.now();
    for (let i = 0; i < ORG_ACTIVE_SESSION_CEILING; i++) {
      await api.providers.db.insert(agentSessions).values({
        id: `child_done_${i}`,
        userId: "local-user",
        orgId: "org-release-test",
        workspace: "/tmp",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await api.providers.db.insert(childWatches).values({
        childSessionId: `child_done_${i}`,
        queueItemId: `qi-done-${i}`,
        parentSessionId: "parent-other",
        parentThreadId: "th-r",
        actorUserId: "local-user",
        orgId: "org-release-test",
        settled: true,
        createdAt: now,
      });
    }

    const result = await spawner(
      { prompt: "after the batch settles" },
      {
        parentSessionId: "parent-release",
        parentThreadId: "th-r",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    expect(result.childSessionId).toBeTruthy();
  });

  it("counts a running child once toward the ceiling, not twice", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-single-count", {
      userId: "local-user",
      orgId: "org-single-count",
      workspace: "/tmp",
    });

    // Ceiling - 1 RUNNING children under a different parent: each one has
    // both an agent_sessions row and an unsettled watch. Double-counting
    // would read this as 2*(ceiling-1) and reject; the true load leaves
    // exactly one free slot.
    const now = Date.now();
    for (let i = 0; i < ORG_ACTIVE_SESSION_CEILING - 1; i++) {
      await api.providers.db.insert(agentSessions).values({
        id: `child_run_${i}`,
        userId: "local-user",
        orgId: "org-single-count",
        workspace: "/tmp",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await api.providers.db.insert(childWatches).values({
        childSessionId: `child_run_${i}`,
        queueItemId: `qi-run-${i}`,
        parentSessionId: "parent-other",
        parentThreadId: "th-s",
        actorUserId: "local-user",
        orgId: "org-single-count",
        settled: false,
        createdAt: now,
      });
    }

    const result = await spawner(
      { prompt: "fits in the last slot" },
      {
        parentSessionId: "parent-single-count",
        parentThreadId: "th-s",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    expect(result.childSessionId).toBeTruthy();
  });

  it("ignores another org's watch rows when counting live sessions", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-cross-org", {
      userId: "local-user",
      orgId: "org-cross-watch",
      workspace: "/tmp",
    });

    // Fill the org to the ceiling with plain live sessions, then point a
    // DIFFERENT org's watch row at one of them. Session ids are globally
    // unique today, but the count must not lean on that: a foreign watch
    // must not release this org's slot.
    const now = Date.now();
    for (let i = 0; i < ORG_ACTIVE_SESSION_CEILING; i++) {
      await api.providers.db.insert(agentSessions).values({
        id: `s_cross_${i}`,
        userId: "local-user",
        orgId: "org-cross-watch",
        workspace: "/tmp",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
    }
    await api.providers.db.insert(childWatches).values({
      childSessionId: "s_cross_0",
      queueItemId: "qi-foreign",
      parentSessionId: "parent-foreign",
      parentThreadId: "th-f",
      actorUserId: "other-user",
      orgId: "org-somewhere-else",
      settled: true,
      createdAt: now,
    });

    const attempt = spawner(
      { prompt: "over the ceiling despite the foreign watch" },
      {
        parentSessionId: "parent-cross-org",
        parentThreadId: "th-f",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChildLimitError);
    if (err instanceof ChildLimitError) {
      expect(err.code).toBe("org_ceiling");
    }
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
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    // Double-fire: direct arm AND a rearm() pass over the unsettled row.
    watcher.arm(watch);
    await watcher.rearm();

    await waitFor(async () => {
      const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-w")).limit(1);
      return rows[0]?.settled === true;
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
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    // Let both in-process attempts (and the retry delay between them) run out.
    await new Promise((r) => setTimeout(r, 150));

    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-ghost")).limit(1);
    expect(rows[0]?.settled).toBe(false);

    // Not a real edge denial, so no edge_denied row — and nothing was
    // actually dropped (the row is still eligible for `rearm()`).
    const drops = await db
      .select()
      .from(eventDropLog)
      .where(eq(eventDropLog.conversationKey, "qi-ghost"));
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
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(eventDropLog)
        .where(and(eq(eventDropLog.reason, "pending_cap"), eq(eventDropLog.conversationKey, itemId)));
      return rows.length > 0;
    });

    // Give the in-process retries a chance to exhaust; the watch must still
    // NOT be settled — the settlement is not lost, just deferred.
    await new Promise((r) => setTimeout(r, 150));
    const cappedRows = await db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-cap-watch"))
      .limit(1);
    expect(cappedRows[0]?.settled).toBe(false);

    // Drain the parent thread and re-arm (the boot backstop) — the signal
    // must now be delivered exactly once.
    for (let i = 0; i < 20; i++) {
      await engineStore.settleUnclaimed("parent-cap-watch", parentThread.id, `cap-filler-${i}`, {
        outcome: "completed",
      });
    }
    await watcher.rearm();

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(childWatches)
        .where(eq(childWatches.childSessionId, "child-cap-watch"))
        .limit(1);
      return rows[0]?.settled === true;
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
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(childWatches)
        .where(eq(childWatches.childSessionId, "child-real-denial"))
        .limit(1);
      return rows[0]?.settled === true;
    });

    const dispatchId = `settled:child-real-denial:${itemId}`;
    const drops = await db
      .select()
      .from(eventDropLog)
      .where(and(eq(eventDropLog.reason, "edge_denied"), eq(eventDropLog.conversationKey, dispatchId)));
    // Exactly one row — `authorizeEdge` logs it; `ChildWatcher` must not
    // double-log an already-logged permanent denial.
    expect(drops).toHaveLength(1);
    expect(drops[0]?.detail).toContain("parent-does-not-exist");

    // A permanent denial is a FAILURE, not a completed run: the parent
    // never received the settlement, so keep the child's sandbox and
    // cached session for debugging. The idle sweep owns the reclaim.
    await new Promise((r) => setTimeout(r, 100));
    expect(engineHost.liveSession("child-real-denial")).not.toBeNull();
  });

  it("tears down the child's sandbox and evicts its cached session on settle, keeping session data", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-td", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor("child-td", {
      parentSessionId: "parent-td",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    // Give the child a live sandbox so the teardown has something real to
    // release.
    await child.attachment.ensureReady({ timeoutMs: 5_000 });
    const attachment = child.attachment;
    expect(attachment.state).toBe("ready");

    const itemId = "qi-td-1";
    await engineStore.admitSubmission("child-td", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-td", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-td",
      queueItemId: itemId,
      parentSessionId: "parent-td",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    await waitFor(async () => {
      const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-td")).limit(1);
      return rows[0]?.settled === true;
    });
    // Teardown runs after markSettled — wait for the eviction.
    await waitFor(async () => engineHost.liveSession("child-td") === null);

    // The sandbox is gone (attachment released), but the session data —
    // what child_read and the Sessions page read — survives.
    expect(attachment.state).toBe("released");
    const childData = await engineStore.getSession("child-td");
    expect(childData).not.toBeNull();
  });

  it("teardown revokes the settled child's sandbox tokens", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-tok", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor("child-tok", {
      parentSessionId: "parent-tok",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");

    // A live bearer token, as minted for the child's sandbox env.
    await db.insert(sandboxTokens).values({
      id: "tok-child-tok",
      tokenHash: "hash-child-tok",
      sessionId: "child-tok",
      userId: "local-user",
      orgId: "local-org",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const itemId = "qi-tok-1";
    await engineStore.admitSubmission("child-tok", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-tok", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-tok",
      queueItemId: itemId,
      parentSessionId: "parent-tok",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    await waitFor(async () => engineHost.liveSession("child-tok") === null);

    const tokens = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "child-tok"));
    expect(tokens[0]?.revokedAt).not.toBeNull();
  });

  it("skips teardown while the child still has an unsettled submission (a user woke it)", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-busy", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor("child-busy", {
      parentSessionId: "parent-busy",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    await child.attachment.ensureReady({ timeoutMs: 5_000 });
    // Keep the child's queue from running the extra item into failure.
    await child.pause();

    const itemId = "qi-busy-1";
    await engineStore.admitSubmission("child-busy", childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed("child-busy", childThread.id, itemId, { outcome: "completed" });
    // A user prompt admitted before the watcher fires — must NOT lose its
    // sandbox to the settle teardown.
    await engineStore.admitSubmission(
      "child-busy",
      childThread.id,
      queuedItem("qi-busy-user", childThread.id, "follow-up"),
    );

    const watch = {
      childSessionId: "child-busy",
      queueItemId: itemId,
      parentSessionId: "parent-busy",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    watcher.arm(watch);

    await waitFor(async () => {
      const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-busy")).limit(1);
      return rows[0]?.settled === true;
    });
    // Give any (buggy) teardown a chance to run, then assert it did not.
    await new Promise((r) => setTimeout(r, 150));

    expect(engineHost.liveSession("child-busy")).not.toBeNull();
    expect(child.attachment.state).toBe("ready");
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

// A 2026-08-06 incident report: a child produced a >100KB final message and
// the whole thing is what the parent would carry. The signal body is the only
// channel from a child to its parent, and it lands in the parent's context on
// every later turn, so it needs a ceiling. The ceiling is only safe because
// `child_read` can fetch the rest — do not lower one without the other.
describe("resultBody", () => {
  const childId = "sess_child_abc";

  it("passes a short result through untouched", () => {
    const body = resultBody({ queueItemId: "q1", outcome: "completed", text: "all done" }, childId);
    expect(body).toBe("all done");
  });

  it("bounds a result that is over the ceiling", () => {
    const huge = "x".repeat(CHILD_RESULT_MAX_CHARS + 50_000);
    const body = resultBody({ queueItemId: "q1", outcome: "completed", text: huge }, childId);
    expect(body.length).toBeLessThan(huge.length);
    expect(body.length).toBeLessThanOrEqual(CHILD_RESULT_MAX_CHARS + 400);
  });

  it("keeps the start of an over-long result", () => {
    const huge = "HEAD-MARKER" + "x".repeat(CHILD_RESULT_MAX_CHARS + 1_000);
    expect(resultBody({ queueItemId: "q1", outcome: "completed", text: huge }, childId)).toContain("HEAD-MARKER");
  });

  it("names how many characters were dropped and how to read them", () => {
    const huge = "x".repeat(CHILD_RESULT_MAX_CHARS + 1_234);
    const body = resultBody({ queueItemId: "q1", outcome: "completed", text: huge }, childId);
    expect(body).toContain("1234");
    expect(body).toContain("child_read");
    // The corrective action is only actionable with the id to act on.
    expect(body).toContain(childId);
  });

  it("bounds a failure result too, so a huge error cannot flood the parent", () => {
    const huge = "e".repeat(CHILD_RESULT_MAX_CHARS + 10_000);
    const body = resultBody({ queueItemId: "q1", outcome: "failed", error: huge }, childId);
    expect(body.length).toBeLessThanOrEqual(CHILD_RESULT_MAX_CHARS + 400);
    expect(body).toContain("child_read");
  });

  it("points a completed-but-textless result at child_read instead of an empty body", () => {
    // `text` is undefined when the terminal entry is gone at read time
    // (e.g. compacted away between settlement and the read).
    const body = resultBody({ queueItemId: "q1", outcome: "completed" }, childId);
    expect(body).not.toBe("");
    expect(body).toContain("child_read");
    expect(body).toContain(childId);
  });

  it("passes a genuinely empty terminal text through unchanged", () => {
    const body = resultBody({ queueItemId: "q1", outcome: "completed", text: "" }, childId);
    expect(body).toBe("");
  });
});

// The reader is the other half of bounding the settled body: a parent that
// gets a truncated result has no other way to reach the rest, because
// `thread_read` stays inside one session.
describe("buildChildReader", () => {
  it("returns the child's messages to the parent that spawned it", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const reader = buildChildReader(deps);

    await api.providers.engineHost.sessionFor("parent-read", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "count the incidents" },
      {
        parentSessionId: "parent-read",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // The spawn prompt is still queued, not yet a persisted entry, so seed
    // the report the child would have written. This is the content a parent
    // comes back for after a truncated child.settled.
    const childSession = await api.providers.engineHost.sessionFor(spawned.childSessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const childThread = childSession.thread();
    await api.providers.engineStore.appendEntries(spawned.childSessionId, childThread.id, [
      {
        id: "e-child-report",
        sessionId: spawned.childSessionId,
        threadId: childThread.id,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "the tail of the report that the signal truncated",
        createdAt: Date.now(),
      },
    ]);

    const entries = await reader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-read" },
    );
    expect(entries).not.toBeNull();
    const text = (entries ?? [])
      .map((e) => (e.type === "message" ? e.content : ""))
      .join("\n");
    expect(text).toContain("the tail of the report that the signal truncated");
  });

  it("returns null for a session the caller did not spawn", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const reader = buildChildReader(deps);

    await api.providers.engineHost.sessionFor("parent-owner", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "secret work" },
      {
        parentSessionId: "parent-owner",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // A different orchestrator naming a real child id it does not own.
    const entries = await reader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-stranger" },
    );
    expect(entries).toBeNull();
  });

  it("returns null for a session id that does not exist, same as for one it cannot see", async () => {
    api = await bootTestApi();
    const reader = buildChildReader(childrenDeps(api));
    const entries = await reader(
      { childSessionId: "child_does-not-exist" },
      { parentSessionId: "parent-read" },
    );
    expect(entries).toBeNull();
  });

  it("still reads a child after it has settled, which is when the parent needs it", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const reader = buildChildReader(deps);

    await api.providers.engineHost.sessionFor("parent-settled", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "long report" },
      {
        parentSessionId: "parent-settled",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    // `markSettled` updates the row rather than deleting it; if that ever
    // changes to a delete, the parent loses the truncated remainder forever.
    await api.providers.db
      .update(childWatches)
      .set({ settled: true })
      .where(eq(childWatches.childSessionId, spawned.childSessionId));

    // Seed the report so the assertion proves CONTENT survives settlement,
    // not merely that the authz edge does.
    const childSession = await api.providers.engineHost.sessionFor(spawned.childSessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const childThread = childSession.thread();
    await api.providers.engineStore.appendEntries(spawned.childSessionId, childThread.id, [
      {
        id: "e-settled-report",
        sessionId: spawned.childSessionId,
        threadId: childThread.id,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "settled report body the parent came back for",
        createdAt: Date.now(),
      },
    ]);

    const entries = await reader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-settled" },
    );
    expect(entries).not.toBeNull();
    const text = (entries ?? []).map((e) => (e.type === "message" ? e.content : "")).join("\n");
    expect(text).toContain("settled report body the parent came back for");
  });

  it("returns null for a soft-deleted child, same as for one that never existed", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const reader = buildChildReader(deps);

    await api.providers.engineHost.sessionFor("parent-del", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "to be deleted" },
      {
        parentSessionId: "parent-del",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // The DELETE route soft-deletes; the watch edge survives. Deletion must
    // close the transcript to the parent all the same.
    await api.providers.db
      .update(agentSessions)
      .set({ status: "deleted" })
      .where(eq(agentSessions.id, spawned.childSessionId));

    const entries = await reader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-del" },
    );
    expect(entries).toBeNull();
  });

  it("is a pure read: purged engine rows answer null and are NOT re-created", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const reader = buildChildReader(deps);

    await api.providers.engineHost.sessionFor("parent-purged", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "short lived" },
      {
        parentSessionId: "parent-purged",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // A delete-while-cached purges the engine rows (session.destroy) while
    // the watch and agent_sessions rows remain. A read must answer null —
    // waking through the engine host here used to re-CREATE a live engine
    // session under the deleted id.
    await api.providers.engineHost.destroy(spawned.childSessionId);
    await api.providers.engineStore.deleteSession(spawned.childSessionId);

    const entries = await reader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-purged" },
    );
    expect(entries).toBeNull();
    expect(await api.providers.engineStore.getSession(spawned.childSessionId)).toBeNull();
  });
});

describe("buildChildStatusReader", () => {
  it("reports settled=false and an activity clock for a freshly spawned child", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const statusReader = buildChildStatusReader(deps);

    await api.providers.engineHost.sessionFor("parent-status", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "long analysis" },
      {
        parentSessionId: "parent-status",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    const status = await statusReader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-status" },
    );
    expect(status).not.toBeNull();
    expect(status?.settled).toBe(false);
    // The spawn admitted the prompt to the child's queue, so the activity
    // clock has a value.
    expect(typeof status?.lastActivityAt).toBe("number");
  });

  it("mirrors the watch row's settled flag", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const statusReader = buildChildStatusReader(deps);

    await api.providers.engineHost.sessionFor("parent-status-settled", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "quick job" },
      {
        parentSessionId: "parent-status-settled",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    await api.providers.db
      .update(childWatches)
      .set({ settled: true })
      .where(eq(childWatches.childSessionId, spawned.childSessionId));

    const status = await statusReader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-status-settled" },
    );
    expect(status?.settled).toBe(true);
  });

  it("returns null for a child the caller did not spawn, and for a missing id", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, new ChildWatcher(deps));
    const statusReader = buildChildStatusReader(deps);

    await api.providers.engineHost.sessionFor("parent-status-owner", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "private work" },
      {
        parentSessionId: "parent-status-owner",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    expect(
      await statusReader(
        { childSessionId: spawned.childSessionId },
        { parentSessionId: "parent-stranger" },
      ),
    ).toBeNull();
    expect(
      await statusReader(
        { childSessionId: "child_does-not-exist" },
        { parentSessionId: "parent-status-owner" },
      ),
    ).toBeNull();
  });
});

describe("parseTaskRepo", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseTaskRepo("tkhq/sdk")).toEqual({
      host: "github",
      fullName: "tkhq/sdk",
      cloneUrl: "https://github.com/tkhq/sdk.git",
      auth: "auto",
    });
  });

  it("parses an https clone URL, with and without .git", () => {
    for (const url of ["https://github.com/tkhq/sdk.git", "https://github.com/tkhq/sdk"]) {
      expect(parseTaskRepo(url)?.fullName).toBe("tkhq/sdk");
      expect(parseTaskRepo(url)?.cloneUrl).toBe("https://github.com/tkhq/sdk.git");
    }
  });

  it("parses an ssh remote", () => {
    expect(parseTaskRepo("git@github.com:tkhq/sdk.git")?.fullName).toBe("tkhq/sdk");
  });

  it("carries the branch as ref", () => {
    expect(parseTaskRepo("tkhq/sdk", "release-1")?.ref).toBe("release-1");
  });

  it("returns undefined for garbage", () => {
    expect(parseTaskRepo("not a repo!!")).toBeUndefined();
    expect(parseTaskRepo("")).toBeUndefined();
    expect(parseTaskRepo("three/part/name")).toBeUndefined();
  });

  it("rejects shorthand owners GitHub disallows", () => {
    // Owners are alphanumeric + hyphen, first char alphanumeric — no
    // leading -/., no dots or underscores anywhere.
    expect(parseTaskRepo("-owner/repo")).toBeUndefined();
    expect(parseTaskRepo(".owner/repo")).toBeUndefined();
    expect(parseTaskRepo("1.0/2.0")).toBeUndefined();
    expect(parseTaskRepo("own_er/repo")).toBeUndefined();
  });

  it("accepts dotted repo names but not a leading hyphen", () => {
    expect(parseTaskRepo("tkhq/.github")?.fullName).toBe("tkhq/.github");
    expect(parseTaskRepo("tkhq/sdk.js")?.fullName).toBe("tkhq/sdk.js");
    expect(parseTaskRepo("tkhq/-repo")).toBeUndefined();
  });
});

// The sender is what makes a child steerable: without it, a parent that
// watches a child drift can only wait for the wrong result. Its correctness
// hinges on re-pointing the watch — the settlement the parent is owed after
// a send is the NEW submission's, never the superseded original's.
describe("buildChildSender", () => {
  /** Hand-built child + watch row (watcher-test idiom): no LLM turn runs. */
  async function seedChild(a: TestApi, opts: { childId: string; parentId: string; settled: boolean; queueItemId: string }) {
    const { engineHost, engineStore, db } = a.providers;
    const parent = await engineHost.sessionFor(opts.parentId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor(opts.childId, {
      parentSessionId: opts.parentId,
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    await child.pause();

    await engineStore.admitSubmission(opts.childId, childThread.id, queuedItem(opts.queueItemId, childThread.id, "original task"));
    if (opts.settled) {
      await engineStore.settleUnclaimed(opts.childId, childThread.id, opts.queueItemId, { outcome: "completed" });
    }

    const now = Date.now();
    await db.insert(agentSessions).values({
      id: opts.childId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(childWatches).values({
      childSessionId: opts.childId,
      queueItemId: opts.queueItemId,
      parentSessionId: opts.parentId,
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      settled: opts.settled,
      createdAt: now,
    });
    return { parent, parentThread, child, childThread };
  }

  function settledSignalsOf(items: QueueItem[]): QueueItem[] {
    return items.filter(
      (i) =>
        typeof i.content === "object" &&
        i.content !== null &&
        "kind" in i.content &&
        i.content.kind === "signal" &&
        (i.content as SignalContent).signalType === "child.settled",
    );
  }

  it("answers null for a session that is not this parent's child", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const sender = buildChildSender(deps, new ChildWatcher(deps));
    expect(
      await sender(
        { childSessionId: "child-nope", message: "hello" },
        { parentSessionId: "parent-x", parentThreadId: "th-x", actorUserId: "local-user" },
      ),
    ).toBeNull();
  });

  it("answers null for another parent's child — same answer as nonexistent", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    await seedChild(api, { childId: "child-owned", parentId: "parent-a", settled: false, queueItemId: "qi-a" });
    const sender = buildChildSender(deps, new ChildWatcher(deps));
    expect(
      await sender(
        { childSessionId: "child-owned", message: "hello" },
        { parentSessionId: "parent-b", parentThreadId: "th-b", actorUserId: "local-user" },
      ),
    ).toBeNull();
  });

  it("answers null for a deleted child", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    await seedChild(api, { childId: "child-del", parentId: "parent-del", settled: false, queueItemId: "qi-del" });
    await api.providers.db
      .update(agentSessions)
      .set({ status: "deleted" })
      .where(eq(agentSessions.id, "child-del"));
    const sender = buildChildSender(deps, new ChildWatcher(deps));
    expect(
      await sender(
        { childSessionId: "child-del", message: "hello" },
        { parentSessionId: "parent-del", parentThreadId: "th-del", actorUserId: "local-user" },
      ),
    ).toBeNull();
  });

  it("steers a running child: supersedes its work, re-points the watch, and the parent gets exactly one child.settled — for the NEW submission", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread, child, childThread } = await seedChild(api, {
      childId: "child-steer",
      parentId: "parent-steer",
      settled: false,
      queueItemId: "qi-orig",
    });
    // The spawner would have armed the watcher on the original submission.
    watcher.arm({
      childSessionId: "child-steer",
      queueItemId: "qi-orig",
      parentSessionId: "parent-steer",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    });

    const sender = buildChildSender(deps, watcher);
    const res = await sender(
      { childSessionId: "child-steer", message: "stop — fix the chart instead", interrupt: true },
      { parentSessionId: "parent-steer", parentThreadId: parentThread.id, actorUserId: "local-user" },
    );
    expect(res).not.toBeNull();
    expect(res?.queueItemId).toBeTruthy();
    expect(res?.queueItemId).not.toBe("qi-orig");

    // Steer semantics: the original submission settled as superseded.
    const orig = await child.thread().awaitResult("qi-orig");
    expect(orig.outcome).toBe("superseded");

    // The watch row now points at the new submission and is live again.
    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-steer")).limit(1);
    expect(rows[0]?.queueItemId).toBe(res?.queueItemId);
    expect(rows[0]?.settled).toBe(false);

    // The stale watcher (armed on qi-orig, which just settled as superseded)
    // must stay silent: no premature child.settled on the parent.
    await new Promise((r) => setTimeout(r, 200));
    expect(settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-steer"))).toHaveLength(0);
    const midRows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-steer")).limit(1);
    expect(midRows[0]?.settled).toBe(false);

    // The child finishes the steered work: exactly one signal, for the new item.
    await engineStore.settleUnclaimed("child-steer", childThread.id, res?.queueItemId ?? "", { outcome: "completed" });
    await waitFor(async () => {
      const r = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-steer")).limit(1);
      return r[0]?.settled === true;
    });
    await new Promise((r) => setTimeout(r, 100));
    const signals = settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-steer"));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dispatchId).toBe(`child-steer:settled:child-steer:${res?.queueItemId}`);
    const content = signals[0]?.content as SignalContent;
    expect(content.attributes?.outcome).toBe("completed");
  });

  it("queues behind a running child by default (no interrupt): the original submission stays unsettled", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread } = await seedChild(api, {
      childId: "child-fu",
      parentId: "parent-fu",
      settled: false,
      queueItemId: "qi-fu-orig",
    });

    const sender = buildChildSender(deps, watcher);
    const res = await sender(
      { childSessionId: "child-fu", message: "when you finish, also update the docs" },
      { parentSessionId: "parent-fu", parentThreadId: parentThread.id, actorUserId: "local-user" },
    );
    expect(res).not.toBeNull();

    // Followup mode: both submissions are live on the child.
    const unsettled = await engineStore.listUnsettledSubmissions("child-fu");
    const ids = unsettled.map((i) => i.id);
    expect(ids).toContain("qi-fu-orig");
    expect(ids).toContain(res?.queueItemId);

    // The watch tracks the LAST submission — its settlement is the one the
    // parent is owed (FIFO: the follow-up settles after the original).
    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-fu")).limit(1);
    expect(rows[0]?.queueItemId).toBe(res?.queueItemId);
  });

  it("re-opens a settled child: the send un-settles the watch and its next settlement reaches the parent", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread, childThread } = await seedChild(api, {
      childId: "child-again",
      parentId: "parent-again",
      settled: true,
      queueItemId: "qi-done",
    });

    // The user dismissed the settled child; a re-open must resurface it.
    await db
      .update(childWatches)
      .set({ dismissedAt: Date.now() })
      .where(eq(childWatches.childSessionId, "child-again"));

    const sender = buildChildSender(deps, watcher);
    // Send from a DIFFERENT thread than the spawn origin: the durable edge
    // (and the settlement signal) must stay with the spawning thread.
    const res = await sender(
      { childSessionId: "child-again", message: "one more thing: add tests" },
      { parentSessionId: "parent-again", parentThreadId: "th-elsewhere", actorUserId: "local-user" },
    );
    expect(res).not.toBeNull();

    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-again")).limit(1);
    expect(rows[0]?.settled).toBe(false);
    expect(rows[0]?.queueItemId).toBe(res?.queueItemId);
    expect(rows[0]?.dismissedAt).toBeNull();
    expect(rows[0]?.parentThreadId).toBe(parentThread.id);

    await engineStore.settleUnclaimed("child-again", childThread.id, res?.queueItemId ?? "", { outcome: "completed" });
    await waitFor(async () => {
      const r = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-again")).limit(1);
      return r[0]?.settled === true;
    });
    await new Promise((r) => setTimeout(r, 100));
    const signals = settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-again"));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dispatchId).toBe(`child-again:settled:child-again:${res?.queueItemId}`);
    expect(signals[0]?.threadId).toBe(parentThread.id);
  });

  it("self-heals a steer whose sender died before the re-point: the watch follows the successor", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const { parentThread, childThread } = await seedChild(api, {
      childId: "child-heal",
      parentId: "parent-heal",
      settled: false,
      queueItemId: "qi-heal-orig",
    });
    watcher.arm({
      childSessionId: "child-heal",
      queueItemId: "qi-heal-orig",
      parentSessionId: "parent-heal",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    });

    // A steer admitted WITHOUT the sender's row update — the crashed-sender
    // shape (also the shape of a user steering the child directly).
    const child = engineHost.liveSession("child-heal");
    expect(child).not.toBeNull();
    const receipt = await child!.prompt("changed my mind — do it differently", {
      author: { id: "local-user" },
      queueMode: "steer",
    });

    // The stale watcher wakes on the superseded original and must move the
    // watch to the successor instead of going silent (or reporting it).
    await waitFor(async () => {
      const r = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-heal")).limit(1);
      return r[0]?.queueItemId === receipt.queueItemId;
    });
    expect(settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-heal"))).toHaveLength(0);

    // The successor settles: exactly one signal, for the successor.
    await engineStore.settleUnclaimed("child-heal", childThread.id, receipt.queueItemId, { outcome: "completed" });
    await waitFor(async () => {
      const r = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-heal")).limit(1);
      return r[0]?.settled === true;
    });
    await new Promise((r) => setTimeout(r, 100));
    const signals = settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-heal"));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dispatchId).toBe(`child-heal:settled:child-heal:${receipt.queueItemId}`);
    const content = signals[0]?.content as SignalContent;
    expect(content.attributes?.outcome).toBe("completed");
  });

  it("re-opening a settled child pays the child cap: the 11th active child is rejected", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { db } = api.providers;

    const { parentThread } = await seedChild(api, {
      childId: "child-capped",
      parentId: "parent-capped",
      settled: true,
      queueItemId: "qi-capped",
    });
    // Fill the parent's cap with unsettled watches (rows are what
    // enforceLimits counts; no live sessions needed).
    const now = Date.now();
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR; i++) {
      await db.insert(childWatches).values({
        childSessionId: `child-filler-${i}`,
        queueItemId: `qi-filler-${i}`,
        parentSessionId: "parent-capped",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        orgId: "local-org",
        settled: false,
        createdAt: now,
      });
    }

    const sender = buildChildSender(deps, watcher);
    await expect(
      sender(
        { childSessionId: "child-capped", message: "wake up" },
        { parentSessionId: "parent-capped", parentThreadId: parentThread.id, actorUserId: "local-user" },
      ),
    ).rejects.toThrow(ChildLimitError);

    // The row must stay settled — a rejected re-open changes nothing.
    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-capped")).limit(1);
    expect(rows[0]?.settled).toBe(true);
  });

  it("serializes concurrent sends to one child: the row tracks the last-admitted submission", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread } = await seedChild(api, {
      childId: "child-race",
      parentId: "parent-race",
      settled: false,
      queueItemId: "qi-race-orig",
    });

    const sender = buildChildSender(deps, watcher);
    const [resA, resB] = await Promise.all([
      sender(
        { childSessionId: "child-race", message: "first follow-up" },
        { parentSessionId: "parent-race", parentThreadId: parentThread.id, actorUserId: "local-user" },
      ),
      sender(
        { childSessionId: "child-race", message: "second follow-up" },
        { parentSessionId: "parent-race", parentThreadId: parentThread.id, actorUserId: "local-user" },
      ),
    ]);
    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();

    // Both submissions are live; the chain admitted A before B, so the row
    // must track B — the last-admitted, last-to-settle submission.
    const ids = (await engineStore.listUnsettledSubmissions("child-race")).map((i) => i.id);
    expect(ids).toContain(resA?.queueItemId);
    expect(ids).toContain(resB?.queueItemId);
    const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-race")).limit(1);
    expect(rows[0]?.queueItemId).toBe(resB?.queueItemId);
  });
});

// Retention (amends the eager-teardown decision now that `child_send`
// exists): on a hibernation-capable backend a settled child's sandbox is
// suspended, not destroyed, so a revival within the retention window
// resumes warm. The retention sweep is what finally reclaims the compute.
describe("child sandbox retention", () => {
  /** VirtualSandbox whose handle-level destroy() reports back to the
   * provider map — the attachment destroys via the handle, not the
   * provider, and the real backends' handles genuinely destroy. */
  class TrackedSandbox extends VirtualSandbox {
    constructor(
      id: string,
      private readonly onDestroy: () => void,
    ) {
      super(id);
    }
    override async destroy(): Promise<void> {
      await super.destroy();
      this.onDestroy();
    }
  }

  class HibernatingChildProvider implements SandboxProvider {
    readonly backend = "hib-child-test";
    readonly suspendCalls: string[] = [];
    hibernation = true;
    private sandboxes = new Map<string, VirtualSandbox>();
    private nextId = 1;

    capabilities(): SandboxCapabilities {
      return {
        snapshot: "none",
        persistentWorkspace: false,
        tunnels: false,
        warmPool: false,
        hibernation: this.hibernation,
        customImage: false,
        coldStartEstimateMs: 0,
      };
    }
    async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
      const id = `hib-child-${this.nextId++}`;
      const sb = new TrackedSandbox(id, () => this.sandboxes.delete(id));
      this.sandboxes.set(id, sb);
      return sb;
    }
    async restore(id: string): Promise<Sandbox> {
      const sb = this.sandboxes.get(id);
      if (!sb) throw new Error(`sandbox not found: ${id}`);
      return sb;
    }
    async destroy(id: string): Promise<void> {
      this.sandboxes.delete(id);
    }
    async status(id: string): Promise<SandboxStatus> {
      return this.sandboxes.has(id) ? { id, state: "ready" } : { id, state: "released" };
    }
    async suspend(id: string): Promise<void> {
      this.suspendCalls.push(id);
    }
    async resume(_id: string): Promise<void> {}
  }

  const RETENTION_MS = 60 * 60 * 1000;

  /** Parent + child with a READY sandbox attachment, a live token, and a
   * settled submission — the state the watcher finds at settle time. */
  async function seedParkableChild(a: TestApi, childId: string, parentId: string) {
    const { engineHost, engineStore, db } = a.providers;
    const parent = await engineHost.sessionFor(parentId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor(childId, {
      parentSessionId: parentId,
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    await child.attachment.ensureReady({ timeoutMs: 5_000 });

    const now = Date.now();
    await db.insert(agentSessions).values({
      id: childId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sandboxTokens).values({
      id: `tok-${childId}`,
      tokenHash: `hash-${childId}`,
      sessionId: childId,
      userId: "local-user",
      orgId: "local-org",
      createdAt: new Date(),
      expiresAt: new Date(now + 3_600_000),
    });

    const itemId = `qi-${childId}`;
    await engineStore.admitSubmission(childId, childThread.id, queuedItem(itemId, childThread.id, "work"));
    await engineStore.settleUnclaimed(childId, childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: childId,
      queueItemId: itemId,
      parentSessionId: parentId,
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: now });
    return { watch, child, childThread };
  }

  async function watchRow(a: TestApi, childId: string) {
    const rows = await a.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, childId))
      .limit(1);
    return rows[0];
  }

  it("parks a settled child by suspending its sandbox: cache kept, tokens kept, status hibernated", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineHost, db } = api.providers;

    const { watch, child } = await seedParkableChild(api, "child-park", "parent-park");
    watcher.arm(watch);

    await waitFor(async () => (await watchRow(api!, "child-park"))?.settled === true);
    await waitFor(async () => provider.suspendCalls.length === 1);

    // Suspended, not destroyed: the session stays cached with a suspended
    // attachment, so a child_send within the window resumes warm.
    expect(engineHost.liveSession("child-park")).not.toBeNull();
    expect(child.attachment.state).toBe("suspended");

    // Tokens survive a park — the wake path needs them.
    const tokens = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "child-park"));
    expect(tokens[0]?.revokedAt).toBeNull();

    // Status mirrors the idle sweep's hibernate stamp.
    const appRows = await db.select().from(agentSessions).where(eq(agentSessions.id, "child-park")).limit(1);
    expect(appRows[0]?.status).toBe("hibernated");

    // Retention bookkeeping: the settle is stamped, the reclaim is owed.
    const row = await watchRow(api, "child-park");
    expect(row?.settledAt).not.toBeNull();
    expect(row?.sandboxReclaimedAt).toBeNull();
  });

  it("falls back to destroy-on-settle when the provider cannot hibernate, and marks the reclaim done", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineHost } = api.providers;

    const { watch } = await seedParkableChild(api, "child-nohib", "parent-nohib");
    watcher.arm(watch);

    await waitFor(async () => engineHost.liveSession("child-nohib") === null);
    expect(provider.suspendCalls).toEqual([]);
    const row = await watchRow(api, "child-nohib");
    expect(row?.sandboxReclaimedAt).not.toBeNull();
  });

  it("retention sweep: destroys a parked sandbox past the window, revokes tokens, stamps the reclaim", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineHost, db } = api.providers;

    const { watch } = await seedParkableChild(api, "child-sweep", "parent-sweep");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);
    const sandboxId = provider.suspendCalls[0] ?? "";

    // Inside the window: nothing reclaimed.
    await watcher.sweepRetention(Date.now());
    expect((await watchRow(api, "child-sweep"))?.sandboxReclaimedAt).toBeNull();
    expect(engineHost.liveSession("child-sweep")).not.toBeNull();

    // Past the window: reclaimed for real.
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    expect((await provider.status(sandboxId)).state).toBe("released");
    expect(engineHost.liveSession("child-sweep")).toBeNull();
    const tokens = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "child-sweep"));
    expect(tokens[0]?.revokedAt).not.toBeNull();
    expect((await watchRow(api, "child-sweep"))?.sandboxReclaimedAt).not.toBeNull();

    // Idempotent: a second pass finds nothing to do.
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 2);
  });

  it("retention sweep: skips a parked child a user has since woken", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineStore, engineHost } = api.providers;

    const { watch, childThread } = await seedParkableChild(api, "child-woke", "parent-woke");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);

    // A user prompt admitted after the park — the sweep must not pull the
    // sandbox out from under it.
    await engineStore.admitSubmission(
      "child-woke",
      childThread.id,
      queuedItem("qi-user-wake", childThread.id, "user follow-up"),
    );

    await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    expect((await watchRow(api, "child-woke"))?.sandboxReclaimedAt).toBeNull();
    expect(engineHost.liveSession("child-woke")).not.toBeNull();
  });

  it("keeps an already-suspended attachment parked at settle instead of destroying it", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineHost, db } = api.providers;

    const { watch, child } = await seedParkableChild(api, "child-presusp", "parent-presusp");
    // The idle sweep (or an earlier park) suspended the sandbox before the
    // settle was observed.
    await child.attachment.suspend();
    expect(child.attachment.state).toBe("suspended");

    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, "child-presusp"))?.settled === true);

    // Parked as-is: nothing destroyed, cache kept, handle recorded.
    expect(engineHost.liveSession("child-presusp")).not.toBeNull();
    expect(child.attachment.state).toBe("suspended");
    const sandboxId = provider.suspendCalls[0] ?? "";
    expect((await provider.status(sandboxId)).state).toBe("ready");
    const row = await watchRow(api, "child-presusp");
    expect(row?.parkedSandboxId).toBe(sandboxId);
    expect(row?.sandboxReclaimedAt).toBeNull();
    const appRows = await db.select().from(agentSessions).where(eq(agentSessions.id, "child-presusp")).limit(1);
    expect(appRows[0]?.status).toBe("hibernated");
  });

  it("retention sweep: recent engine activity defers the reclaim (a user conversing with a parked child)", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    // Tiny window so real wall-clock activity can land inside/outside it.
    const deps = childrenDeps(api, { retentionMs: 100 });
    const watcher = new ChildWatcher(deps);
    const { engineStore, engineHost } = api.providers;

    const { watch, childThread } = await seedParkableChild(api, "child-active", "parent-active");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);

    // Let the settledAt clock fall outside the window, then stamp fresh
    // engine activity (a user turn that settled — no child_watches touch).
    await new Promise((r) => setTimeout(r, 150));
    await engineStore.admitSubmission(
      "child-active",
      childThread.id,
      queuedItem("qi-user-turn", childThread.id, "user chat"),
    );
    await engineStore.settleUnclaimed("child-active", childThread.id, "qi-user-turn", { outcome: "completed" });

    // settledAt is stale but activity is fresh: the sweep must defer.
    await watcher.sweepRetention();
    expect((await watchRow(api, "child-active"))?.sandboxReclaimedAt).toBeNull();
    expect(engineHost.liveSession("child-active")).not.toBeNull();

    // Once the activity clock is stale too, the reclaim proceeds.
    await new Promise((r) => setTimeout(r, 150));
    await watcher.sweepRetention();
    expect((await watchRow(api, "child-active"))?.sandboxReclaimedAt).not.toBeNull();
  });

  it("retention sweep: reclaims an uncached child via its stored sandboxId", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = new ChildWatcher(deps);
    const { engineHost, db } = api.providers;

    const { watch } = await seedParkableChild(api, "child-cold", "parent-cold");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);
    const sandboxId = provider.suspendCalls[0] ?? "";

    // Simulate an api restart: the parked session is no longer cached.
    engineHost.evictCache("child-cold");
    expect(engineHost.liveSession("child-cold")).toBeNull();

    await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    expect((await provider.status(sandboxId)).state).toBe("released");
    const tokens = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "child-cold"));
    expect(tokens[0]?.revokedAt).not.toBeNull();
    expect((await watchRow(api, "child-cold"))?.sandboxReclaimedAt).not.toBeNull();
  });
});

function parentSandboxWithFile(path: string, content: string): Sandbox {
  const abs = `/workspace/${path}`;
  return {
    id: "sb-parent-share",
    readFile: async () => content,
    readBinary: async (p: string) => {
      if (p === abs) return new TextEncoder().encode(content);
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async (p: string) => {
      if (p === abs) return { isFile: true, isDirectory: false, size: content.length };
      throw new Error(`ENOENT: ${p}`);
    },
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

describe("spawn-time file shares", () => {
  it("stages each files[] entry for the child before it runs, defaulting to .valet/shared/", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);

    const parent = await api.providers.engineHost.sessionFor("parent-share", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    const result = await spawner(
      {
        prompt: "read the report",
        files: [
          { from: "report.md" },
          { from: "report.md", to: "input/copy.md" },
        ],
      },
      {
        parentSessionId: "parent-share",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
        sandbox: parentSandboxWithFile("report.md", "the report\n"),
      },
    );

    const staged = await api.providers.db
      .select()
      .from(sessionStagedFiles)
      .where(eq(sessionStagedFiles.sessionId, result.childSessionId));
    const targets = staged.map((r) => r.targetPath).sort();
    expect(targets).toEqual([".valet/shared/report.md", "input/copy.md"]);
    expect(staged.every((r) => r.origin === "share")).toBe(true);
    expect(staged.every((r) => r.originKey === "parent-share")).toBe(true);
  });

  it("fails the spawn with the missing path named when a files[] source does not exist", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);

    const parent = await api.providers.engineHost.sessionFor("parent-share-miss", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    await expect(
      spawner(
        { prompt: "x", files: [{ from: "missing.bin" }] },
        {
          parentSessionId: "parent-share-miss",
          parentThreadId: parentThread.id,
          actorUserId: "local-user",
          owner: { type: "user", id: "local-user" },
          sandbox: parentSandboxWithFile("report.md", "irrelevant"),
        },
      ),
    ).rejects.toThrow(/missing\.bin/);
  });
});

describe("buildChildFilePusher", () => {
  it("stages a push for an owned child and answers null for a non-child", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = new ChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const pusher = buildChildFilePusher(deps);

    const parent = await api.providers.engineHost.sessionFor("parent-push", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    const spawned = await spawner(
      { prompt: "wait for files" },
      {
        parentSessionId: "parent-push",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    const sandbox = parentSandboxWithFile("notes.md", "v2 notes\n");
    const pushed = await pusher(
      { childSessionId: spawned.childSessionId, from: "notes.md" },
      { parentSessionId: "parent-push", sandbox },
    );
    expect(pushed?.targetPath).toBe(".valet/shared/notes.md");

    const staged = await api.providers.db
      .select()
      .from(sessionStagedFiles)
      .where(eq(sessionStagedFiles.sessionId, spawned.childSessionId));
    expect(staged).toHaveLength(1);
    expect(staged[0].inlineContent).toBe("v2 notes\n");

    const denied = await pusher(
      { childSessionId: spawned.childSessionId, from: "notes.md" },
      { parentSessionId: "somebody-else", sandbox },
    );
    expect(denied).toBeNull();
  });
});
