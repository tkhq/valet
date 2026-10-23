/**
 * Child spawner limits + durable ChildWatcher (Phase 4 Task 8, decisions
 * 10/11/21). Unit-level over a real bootTestApi() stack — no LLM turn is
 * ever required to pass: the watcher test hand-settles the child's
 * submission via the engine store directly, and the parent thread is paused
 * so the admitted `child.settled` signal stays observable in the queue.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { CONTINUATION_SOURCE_ITEM_KEY, INHERIT_TOOL_SCOPE_KEY, UNATTENDED_WORKFLOW_KEY, WORKFLOW_STEP_KEY } from "@valet/shared";
import { RegistryCapacityError } from "../bakes/registry-health.js";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and, sql } from "drizzle-orm";
import type {
  ChannelOrigin,
  QueueItem,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
  PluginActionContext,
  SignalContent,
  SessionStore,
  Session,
  Wakeup,
} from "@valet/engine";
import { cancelChildDelivery } from "./child-delivery.js";
import { childGateOrigin } from "./children.js";
import { cancelAllWorkAsHuman, cancelWorkAsHuman, endChildSubscriptions } from "../engine/wakeups-admin.js";
import * as sandboxTokenAuth from "../auth/sandbox-tokens.js";
import { buildWakeupsSeam } from "../engine/wakeups-seam.js";
import { WakeWatcher } from "../engine/wake-watcher.js";
import { resolveWakeupLimits } from "../providers/sandbox-backend.js";
import { VirtualSandbox } from "@valet/engine";
import * as engineMetrics from "@valet/engine";
import { startGithubFixture } from "../test-helpers/github-fixture.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  buildChildReader,
  buildChildSender,
  childSendPromptOptions,
  isParentDelegation,
  parentDelegationMetadata,
  buildChildSpawner,
  buildChildStatusReader,
  ChildWatcher,
  CHILD_TERMINAL_SIGNAL_GRACE_MS,
  ChildLimitError,
  childParkAction,
  classifyWatcherError,
  resolveChildSettlement,
  type ChildrenDeps,
  resultBody,
  parseTaskRepo,
  CHILD_RESULT_MAX_CHARS,
} from "./children.js";
import { MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR, DEFAULT_ORG_ACTIVE_SESSION_CEILING } from "./limits.js";
import { agentSessions, bakes, childEventOutbox, childReplyDeliveries, childWatches, eventReceipts, events, eventDeliveries, eventSubscriptions, eventDropLog, imageSources, sandboxTokens, sessionRepos, teams, teamMembers } from "../schema/index.js";
import { PendingCapError, ValidationError as EngineValidationError } from "@valet/engine";
import { isScratchRequestError } from "@valet/shared";
import { admitSignal, SignalEdgeDeniedError } from "./signals.js";
import { submitSessionPrompt } from "../routes/messages.js";
import { InstanceClient } from "../cli/client.js";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { shareCredential } from "../services/credential-shares.js";
import { eventsActionPlugin } from "../events/actions.js";

const watchers: ChildWatcher[] = [];
let api: TestApi | undefined;
let childDelivery: WakeWatcher | undefined;
let githubFixture: ReturnType<typeof startGithubFixture> | undefined;

afterEach(async () => {
  await Promise.all(watchers.splice(0).map(w => w.stopRetentionSweep()));
  childDelivery = undefined;
  await api?.cleanup();
  api = undefined;
  await githubFixture?.close();
  githubFixture = undefined;
});

function childrenDeps(a: TestApi, overrides: Partial<ChildrenDeps> = {}): ChildrenDeps {
  return {
    db: a.providers.db,
    engineHost: a.providers.engineHost,
    engineStore: a.providers.engineStore,
    prebuildService: a.providers.prebuildService,
    workspaceRoot: mkdtempSync(join(tmpdir(), "valet-children-test-")),
    scratchCaps: {},
    ...overrides,
  };
}

function testChildWatcher(deps: ChildrenDeps): ChildWatcher {
  const watcher = new ChildWatcher(deps);
  watchers.push(watcher);
  if (!api) throw new Error("Boot the test API before creating a watcher.");
  childDelivery = new WakeWatcher({
    db: deps.db, engineHost: deps.engineHost, engineStore: deps.engineStore,
    provider: api.providers.sandboxProvider, limits: resolveWakeupLimits(process.env),
    childEvents: { active: (row) => watcher.subscriptionActive(row), deliver: (row, digest) => watcher.deliverEvent(row, digest), close: (row) => watcher.closeSubscription(row), finish: (row, blocked) => watcher.finishDeliveryPass(row, blocked) },
  });
  return watcher;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await childDelivery?.sweep();
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


/** Completed watcher fixtures need the same terminal response as a real submission. */
async function appendTerminalResult(store: SessionStore, sessionId: string, threadId: string, queueItemId: string): Promise<void> {
  await store.appendEntries(sessionId, threadId, [{
    id: `terminal-${queueItemId}`, sessionId, threadId, queueItemId, parentId: null,
    type: "message", role: "assistant", content: "done", stopReason: "end_turn", createdAt: Date.now(),
  }]);
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
    const watcher = testChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);

    const parent = await api.providers.engineHost.sessionFor("parent-spawn", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    const owner = { type: "team" as const, id: "team-x" };
    await parentThread.setToolFocus({ actions: ["workflows.get_run"] });

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
    // The spawned work carries parent delegation provenance, so a later
    // promotion of it is not mistaken for a person taking over.
    const spawnedItem = await api.providers.engineStore.getQueueItem(result.childSessionId, result.queueItemId);
    expect(isParentDelegation(spawnedItem)).toBe(true);

    const child = api.providers.engineHost.liveSession(result.childSessionId);
    expect(child).not.toBeNull();
    expect(child?.options.purpose).toBe("child");
    expect(child?.options.parentSessionId).toBe("parent-spawn");
    expect(child?.options.parentThreadId).toBe(parentThread.id);
    expect(child?.owner).toEqual(owner);
    // The parent's thread focus is its own choice and does not limit the child.
    expect((await api.providers.engineStore.getSession(result.childSessionId))?.metadata?.toolScope).toBeUndefined();
    const ceiled = await spawner(
      { prompt: "read the run", title: "Ceiling", toolScope: { actions: ["workflows.get_run"] } },
      { parentSessionId: "parent-spawn", parentThreadId: parentThread.id, actorUserId: "local-user", owner },
    );
    expect((await api.providers.engineStore.getSession(ceiled.childSessionId))?.metadata?.toolScope).toEqual({ actions: ["workflows.get_run"] });
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

  it("marks a child spawned or steered by an unattended workflow task unattended too", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    const parent = await api.providers.engineHost.sessionFor("parent-unattended", { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
    const parentThread = parent.thread("signal:workflow:wfrun_child");
    const ctx = { parentSessionId: "parent-unattended", parentThreadId: parentThread.id, actorUserId: "local-user", owner: { type: "user" as const, id: "local-user" } };
    const step = { runId: "wfrun_child", nodeId: "report" };
    const dispatch = await parentThread.submitPrompt("report", { metadata: { [WORKFLOW_STEP_KEY]: step } });
    const unattended = await spawner({ prompt: "check the release" }, { ...ctx, unattendedWorkflow: true, parentQueueItemId: dispatch.queueItemId });
    const childMetadata = (await api.providers.engineStore.getQueueItem(unattended.childSessionId, unattended.queueItemId))?.metadata;
    expect(childMetadata?.[UNATTENDED_WORKFLOW_KEY]).toBe(true);
    // The child works in the parent's workflow step.
    expect(childMetadata?.[WORKFLOW_STEP_KEY]).toEqual(step);
    const attended = await spawner({ prompt: "check the release" }, { ...ctx, parentQueueItemId: dispatch.queueItemId });
    expect((await api.providers.engineStore.getQueueItem(attended.childSessionId, attended.queueItemId))?.metadata?.[UNATTENDED_WORKFLOW_KEY]).toBeUndefined();
    expect((await api.providers.engineStore.getQueueItem(attended.childSessionId, attended.queueItemId))?.metadata?.[WORKFLOW_STEP_KEY]).toBeUndefined();
    expect(childSendPromptOptions({ ...ctx, unattendedWorkflow: true, workflowStep: step }, false).metadata).toMatchObject({ [UNATTENDED_WORKFLOW_KEY]: true, [WORKFLOW_STEP_KEY]: step });
    expect(childSendPromptOptions({ ...ctx, workflowStep: step }, false).metadata[WORKFLOW_STEP_KEY]).toBeUndefined();
  });

  it("keeps Problems metadata redacted in a child spawned from a channel turn", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const parent = await api.providers.engineHost.sessionFor("parent-channel-child", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    const spawned = await buildChildSpawner(deps, testChildWatcher(deps))(
      { prompt: "inspect event problems" },
      {
        parentSessionId: parent.id,
        parentThreadId: parent.thread("web:default").id,
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
        origin: { channelType: "slack", threadKey: "slack:C1:1.2" },
      },
    );
    const child = api.providers.engineHost.liveSession(spawned.childSessionId);
    expect(child?.options.sharedTranscript).toBe(true);
    api.providers.engineHost.evictCache(spawned.childSessionId);
    const rebuilt = await api.providers.engineHost.sessionFor(spawned.childSessionId, {
      userId: "local-user", orgId: "local-org", workspace: child?.options.workspace ?? "/tmp",
    });
    expect(rebuilt.options.sharedTranscript).toBe(true);
    await api.providers.db.insert(eventDropLog).values([
      {
        id: "child-secret", orgId: "local-org", reason: "filter_excluded", eventKey: "slack.message",
        eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET" },
        detail: "filtered", createdAt: 2_000,
      },
      { id: "child-interaction", orgId: "local-org", reason: "slack_interaction_unmatched", detail: "form details", createdAt: 1_000 },
    ]);
    const action = eventsActionPlugin(api.providers.db).actions.find((entry) => entry.id === "events.list_problems");
    if (!action) throw new Error("events.list_problems is not registered");
    const actionContext = {
      userId: "local-user",
      orgId: "local-org",
      actionId: "events.list_problems",
      service: "events",
      owner: { type: "user", id: "local-user" },
      sharedTranscript: rebuilt.options.sharedTranscript,
    } as PluginActionContext;

    const result = await action.execute({}, actionContext);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret payroll message");
    expect(JSON.stringify(result)).not.toContain("B_SECRET");
    expect(JSON.stringify(result)).not.toContain("child-interaction");
    expect(await action.execute({ text: "secret payroll message" }, actionContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
    expect(await action.execute({ bot_id: "B_SECRET" }, actionContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
  });

  // A team orchestrator from before owner-mode resolution keeps resolving
  // as the acting member (credential_owner_mode "actor"); the tasks it
  // delegates must resolve the same way, or the parent and its children
  // would act with different credentials mid-conversation.
  it("copies an actor-mode parent's credential owner mode onto the child row", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const spawner = buildChildSpawner(deps, watcher);
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "parent-actor",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "team",
      ownerId: "team-x",
      credentialOwnerMode: "actor",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    const parent = await api.providers.engineHost.sessionFor("parent-actor", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");

    const result = await spawner(
      { prompt: "do the thing" },
      { parentSessionId: "parent-actor", parentThreadId: parentThread.id, actorUserId: "local-user", owner: { type: "team", id: "team-x" } },
    );
    const rows = await api.providers.db
      .select({ mode: agentSessions.credentialOwnerMode })
      .from(agentSessions)
      .where(eq(agentSessions.id, result.childSessionId))
      .limit(1);
    expect(rows[0]?.mode).toBe("actor");
  });

  it("threads profile/docker to the child's sandbox options and persists them on the row (defaults: headless, no docker)", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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

  it("passes task resources to the first child build and persists only explicit overrides", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    const childSessionFor = vi.spyOn(api.providers.engineHost, "childSessionFor");
    const parent = await api.providers.engineHost.sessionFor("parent-resources", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const ctx = {
      parentSessionId: "parent-resources",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      owner: { type: "user" as const, id: "local-user" },
    };

    const overridden = await spawner({ prompt: "small task", resources: { cpu: 2 } }, ctx);
    expect(childSessionFor).toHaveBeenCalledWith(overridden.childSessionId, expect.objectContaining({
      resources: { cpu: 2 },
    }));
    const [overriddenRow] = await api.providers.db
      .select({ resources: agentSessions.sandboxResourceOverrides })
      .from(agentSessions)
      .where(eq(agentSessions.id, overridden.childSessionId));
    expect(overriddenRow?.resources).toEqual({ cpu: 2 });

    const inherited = await spawner({ prompt: "normal task" }, ctx);
    const [inheritedRow] = await api.providers.db
      .select({ resources: agentSessions.sandboxResourceOverrides })
      .from(agentSessions)
      .where(eq(agentSessions.id, inherited.childSessionId));
    expect(inheritedRow?.resources).toBeNull();
  });

  it("rejects a task scratch request over the agent cap and inserts no agent_sessions row", async () => {
    api = await bootTestApi();
    const recordScratchRefused = vi.fn();
    const deps = childrenDeps(api, { scratchCaps: { max: "1Ti", agentMax: "100Gi" }, recordScratchRefused });
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    const parent = await api.providers.engineHost.sessionFor("parent-scratch-refused", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const ctx = {
      parentSessionId: "parent-scratch-refused",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      owner: { type: "user" as const, id: "local-user" },
    };

    let err: unknown;
    try {
      await spawner({ sessionId: "child-scratch-refused", prompt: "work", resources: { scratch: "200Gi" } }, ctx);
    } catch (e) {
      err = e;
    }
    expect(isScratchRequestError(err)).toBe(true);
    expect(
      await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, "child-scratch-refused")),
    ).toHaveLength(0);
    // Fix wave 3 (data L5): the task source counts its refusals too.
    expect(recordScratchRefused).toHaveBeenCalledWith("task", expect.any(String));
  });

  it("persists a task scratch request inside both caps", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api, { scratchCaps: { max: "1Ti", agentMax: "100Gi" } });
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    const parent = await api.providers.engineHost.sessionFor("parent-scratch-ok", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const ctx = {
      parentSessionId: "parent-scratch-ok",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      owner: { type: "user" as const, id: "local-user" },
    };

    const spawned = await spawner({ prompt: "work", resources: { scratch: "50Gi" } }, ctx);
    const [row] = await api.providers.db
      .select({ resources: agentSessions.sandboxResourceOverrides })
      .from(agentSessions)
      .where(eq(agentSessions.id, spawned.childSessionId));
    expect(row?.resources).toEqual({ scratch: "50Gi" });
  });

  it("removes the authoritative row, repo binding, and directory when the first build fails", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const parent = await api.providers.engineHost.sessionFor("parent-build-failure", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    vi.spyOn(deps.engineHost, "childSessionFor").mockRejectedValue(new Error("build failed"));
    vi.spyOn(deps.engineStore, "deleteWakeupRows").mockRejectedValue(new Error("waiter cleanup failed"));

    await expect(buildChildSpawner(deps, testChildWatcher(deps))({
      sessionId: "child-build-failure",
      prompt: "work",
      repo: "acme/widgets",
      resources: { cpu: 2 },
    }, {
      parentSessionId: parent.id,
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      owner: { type: "user", id: "local-user" },
    })).rejects.toThrow("build failed");

    expect(await deps.db.select().from(agentSessions)
      .where(eq(agentSessions.id, "child-build-failure"))).toHaveLength(0);
    expect(await deps.db.select().from(sessionRepos)
      .where(eq(sessionRepos.sessionId, "child-build-failure"))).toHaveLength(0);
    expect(readdirSync(deps.workspaceRoot!)).toHaveLength(0);
  });

  it("cleans a prompt failure and safely retries its preassigned id", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const parent = await deps.engineHost.sessionFor("parent-prompt-failure", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    const original = deps.engineHost.childSessionFor.bind(deps.engineHost);
    vi.spyOn(deps.engineHost, "childSessionFor").mockImplementation(async (...args) => {
      const child = await original(...args);
      vi.spyOn(child, "prompt").mockRejectedValueOnce(new Error("prompt failed"));
      return child;
    });
    const spawn = buildChildSpawner(deps, testChildWatcher(deps));
    const req = { sessionId: "child-prompt-failure", prompt: "work", repo: "acme/widgets" };
    const ctx = {
      parentSessionId: parent.id, parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user", owner: { type: "user" as const, id: "local-user" },
    };

    await expect(spawn(req, ctx)).rejects.toThrow("prompt failed");
    expect(await deps.engineStore.getSession(req.sessionId)).toBeNull();
    expect(await deps.db.select().from(agentSessions).where(eq(agentSessions.id, req.sessionId))).toHaveLength(0);
    expect(await deps.db.select().from(sessionRepos).where(eq(sessionRepos.sessionId, req.sessionId))).toHaveLength(0);
    expect(await deps.db.select().from(childWatches).where(eq(childWatches.childSessionId, req.sessionId))).toHaveLength(0);

    vi.mocked(deps.engineHost.childSessionFor).mockRestore();
    await expect(spawn(req, ctx)).resolves.toMatchObject({ childSessionId: req.sessionId });
    await expect(spawn(req, ctx)).rejects.toThrow("already belongs to an existing session");
    expect(await deps.engineStore.getSession(req.sessionId)).not.toBeNull();
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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

  it("child_send after a cache eviction rebuilds the child with its persisted sandbox shape", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
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
    const spawned = await spawner({
      prompt: "dind work",
      profile: "full",
      docker: true,
      resources: { cpu: 2 },
    }, ctx);

    // Drain the old owner before simulating a graceful restart. Active owners cannot be cache-evicted.
    const original = api.providers.engineHost.liveSession(spawned.childSessionId);
    if (!original) throw new Error("child was not cached");
    await original.thread().abort();
    await vi.waitFor(() => expect(original.hasActiveExecution).toBe(false));
    api.providers.engineHost.evictAll({ shutdown: false });
    expect(api.providers.engineHost.liveSession(spawned.childSessionId)).toBeNull();

    await sender({ childSessionId: spawned.childSessionId, message: "continue" }, ctx);

    const rebuilt = api.providers.engineHost.liveSession(spawned.childSessionId);
    expect(rebuilt).not.toBeNull();
    expect(asCreateOpts(rebuilt?.options.sandbox)?.profile).toBe("full");
    expect(asCreateOpts(rebuilt?.options.sandbox)?.docker).toBe(true);
    expect(asCreateOpts(rebuilt?.options.sandbox)?.resources).toEqual({ cpu: 2 });
  });

  it("binds req.repo: session_repos row, clone prep wired, repo image source upserted", async () => {
    githubFixture = startGithubFixture();
    api = await bootTestApi({ githubApiUrl: githubFixture.url });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", {
      type: "api_key", accessToken: "org-test-token",
    });
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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

    // A verified repository gets an automatic source without a builder.
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-ceiling", {
      userId: "local-user",
      orgId: "org-ceiling-test",
      workspace: "/tmp",
    });

    const now = Date.now();
    for (let i = 0; i < DEFAULT_ORG_ACTIVE_SESSION_CEILING; i++) {
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-release", {
      userId: "local-user",
      orgId: "org-release-test",
      workspace: "/tmp",
    });

    // Fill the org to the ceiling entirely with SETTLED children. Each child
    // keeps its agent_sessions row after settlement (spawn inserts it; nothing
    // deletes it) — finished work must not consume capacity forever.
    const now = Date.now();
    for (let i = 0; i < DEFAULT_ORG_ACTIVE_SESSION_CEILING; i++) {
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

  it("does not hold org-ceiling slots for hibernated or archived sessions", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

    await api.providers.engineHost.sessionFor("parent-parked", {
      userId: "local-user",
      orgId: "org-parked-test",
      workspace: "/tmp",
    });

    // Fill the org past the ceiling with parked sessions: hibernated (idle
    // sweep suspended the sandbox) and archived (user shelved it). Neither
    // consumes compute, so neither may consume capacity.
    const now = Date.now();
    for (let i = 0; i < DEFAULT_ORG_ACTIVE_SESSION_CEILING + 5; i++) {
      await api.providers.db.insert(agentSessions).values({
        id: `s_parked_${i}`,
        userId: "local-user",
        orgId: "org-parked-test",
        workspace: "/tmp",
        status: i % 2 === 0 ? "hibernated" : "archived",
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
    }

    const result = await spawner(
      { prompt: "parked sessions must not count" },
      {
        parentSessionId: "parent-parked",
        parentThreadId: "th-p",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );
    expect(result.childSessionId).toBeTruthy();
  });

  it("counts a running child once toward the ceiling, not twice", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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
    for (let i = 0; i < DEFAULT_ORG_ACTIVE_SESSION_CEILING - 1; i++) {
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));

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
    for (let i = 0; i < DEFAULT_ORG_ACTIVE_SESSION_CEILING; i++) {
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
    const watcher = testChildWatcher(deps);
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
    await appendTerminalResult(engineStore, "child-w", childThread.id, itemId);
    await engineStore.settleUnclaimed("child-w", childThread.id, itemId, { outcome: "completed" });

    await db.insert(agentSessions).values({
      id: "child-w",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      sandboxResourceOverrides: { cpu: 2 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

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
    engineHost.evictCache("child-w");
    const sessionFor = vi.spyOn(engineHost, "sessionFor");
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
    expect(sessionFor).toHaveBeenCalledWith("child-w", expect.objectContaining({
      sandboxResourceOverrides: { cpu: 2 },
    }));
    const content = settledSignals[0]?.content as SignalContent;
    expect(content.attributes?.child_session_id).toBe("child-w");
    expect(content.attributes?.outcome).toBe("completed");
  });

  describe("child event subscriptions", () => {
    async function armedChild(name: string, overrides: Partial<ChildrenDeps> = {}, origin?: ChannelOrigin) {
      api = await bootTestApi();
      const deps = childrenDeps(api, overrides);
      const watcher = testChildWatcher(deps);
      const { engineHost, engineStore, db } = api.providers;
      const parent = await engineHost.sessionFor(`parent-${name}`, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
      const parentThread = parent.thread("web:default");
      await parent.pause();
      const child = await engineHost.childSessionFor(`child-${name}`, {
        parentSessionId: `parent-${name}`,
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        orgId: "local-org",
        owner: { type: "user", id: "local-user" },
        workspace: "/tmp",
      });
      const childThread = child.thread("web:default");
      await child.pause();
      const itemId = `qi-${name}-1`;
      await engineStore.admitSubmission(`child-${name}`, childThread.id, { ...queuedItem(itemId, childThread.id, "work"),
        metadata: parentDelegationMetadata(parent.id, parentThread.id, origin) });
      await engineStore.settleUnclaimed(`child-${name}`, childThread.id, itemId, { outcome: "completed" });
      await db.insert(agentSessions).values({
        id: `child-${name}`, userId: "local-user", orgId: "local-org", workspace: "/tmp", status: "active",
        ownerType: "user", ownerId: "local-user", profile: "headless", createdAt: Date.now(), updatedAt: Date.now(),
      });
      const watch = {
        childSessionId: `child-${name}`, queueItemId: itemId, parentSessionId: `parent-${name}`,
        parentThreadId: parentThread.id, actorUserId: "local-user", orgId: "local-org",
      };
      await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });
      const settled = async () =>
        (await db.select().from(childWatches).where(eq(childWatches.childSessionId, `child-${name}`)).limit(1))[0]?.settled === true;
      const settledSignal = async () =>
        (await engineStore.listUnsettledSubmissions(`parent-${name}`))
          .map((i) => i.content)
          .reverse().find((c): c is SignalContent => typeof c === "object" && c !== null && "kind" in c && c.kind === "signal" && c.signalType === "child.settled");
      return { watcher, watch, engineStore, childThread, child, parent, parentThread, deps, settled, settledSignal };
    }


    it.each(["result", "background-work"] as const)("delivers child settlement with NUL in %s", async kind => {
      const c = await armedChild(`nul-${kind}`);
      const db = api!.providers.db;
      const result = vi.spyOn(c.childThread, "awaitResult").mockResolvedValue({
        queueItemId: c.watch.queueItemId, outcome: "completed", text: kind === "result" ? "finished\u0000work" : "finishedwork",
      });
      const leases = c.engineStore.listActiveLeases.bind(c.engineStore);
      const reason = kind === "background-work" ? vi.spyOn(c.engineStore, "listActiveLeases").mockImplementation(async id => [
        ...await leases(id), ...(id === c.child.id ? [{ id: "ls-nul-reason", sessionId: id, threadId: c.childThread.id,
          sourceQueueItemId: c.watch.queueItemId, ownerKind: "hold" as const, reason: "watching\u0000build",
          createdAt: 1, deadlineAt: Date.now() + 60_000 }] : []),
      ]) : undefined;
      // Keep the outbox pending long enough to inspect the exact jsonb record and its nested payload.
      const delivery = vi.spyOn(c.parentThread, "submitPrompt").mockRejectedValue(new Error("hold parent admission"));
      try {
        c.watcher.arm(c.watch);
        await vi.waitFor(async () => expect(await db.select().from(childEventOutbox)).toHaveLength(1));
        const [pending] = await db.select().from(childEventOutbox);
        expect(pending!.event.summary).toContain("finishedwork");
        expect(JSON.stringify(pending!.event)).not.toContain("\\u0000");
        if (kind === "background-work") {
          expect(pending!.event.payload).toMatchObject({ backgroundWork: [{ reason: "watchingbuild" }] });
          expect(JSON.parse(pending!.event.refs.background_work!)).toMatchObject([{ reason: "watchingbuild" }]);
        }
        await vi.waitFor(async () => {
          const waiter = await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`);
          const digest = waiter?.eventBuffer?.find(event => event.dedupeKey === pending!.id);
          expect(digest?.summary).toContain("finishedwork");
          expect(JSON.stringify(digest)).not.toContain("\\u0000");
        });
        delivery.mockRestore();
        await c.watcher.retryOutbox();
        await waitFor(c.settled);
        expect((await c.settledSignal())?.body).toContain("finishedwork");
        expect((await c.settledSignal())?.body).not.toContain("\u0000");
        if (kind === "background-work") expect((await c.settledSignal())?.body).toContain("watchingbuild");
        expect(await db.select().from(childEventOutbox)).toHaveLength(0);
      } finally { result.mockRestore(); delivery.mockRestore(); reason?.mockRestore(); }
    });

    it.each(["hold", "timer", "event"] as const)("counts notified children with %s work against child and org capacity", async (kind) => {
      const c = await armedChild(`capacity-${kind}`);
      const db = api!.providers.db;
      const now = Date.now();
      for (let n = 0; n < MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR; n++) {
        const childSessionId = `busy-${n}`;
        await db.insert(childWatches).values({ ...c.watch, childSessionId, queueItemId: `busy-qi-${n}`, settled: true, createdAt: now,
 });
        if (kind === "hold") await c.engineStore.createLease({ id: `ls_busy-${n}`, sessionId: childSessionId, ownerKind: "hold", reason: "busy", createdAt: now, deadlineAt: now + 60_000 });
        else await c.engineStore.createWakeup({
          id: `wk_busy-${n}`, sessionId: childSessionId, threadId: `busy-th-${n}`, kind, status: kind === "timer" ? "pending" : "running", reason: "busy",
          ...(kind === "timer" ? { fireAt: now + 60_000, prompt: "wake" } : { deadlineAt: now + 60_000, subjects: ["github:acme/repo#1"],
            eventMatch: { clauses: [{ key: "github.check_run.completed" }], self: [], once: true } }),
          logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now,
        });
      }
      await expect(buildChildSpawner(c.deps, c.watcher)({ prompt: "more" }, { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id,
        actorUserId: "local-user", owner: { type: "user", id: "local-user" } })).rejects.toMatchObject({ code: "child_cap" });
      await db.update(childWatches).set({ parentSessionId: "other-parent" }).where(sql`${childWatches.childSessionId} LIKE 'busy-%'`);
      await db.update(childWatches).set({ settled: true }).where(eq(childWatches.childSessionId, c.child.id));
      const limited = { ...c.deps, orgSessionCeiling: MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR };
      await expect(buildChildSpawner(limited, c.watcher)({ prompt: "more" }, { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id,
        actorUserId: "local-user", owner: { type: "user", id: "local-user" } })).rejects.toMatchObject({ code: "org_ceiling" });
      await expect(buildChildSender(limited, c.watcher)({ childSessionId: c.child.id, message: "resume" }, {
        parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user" })).rejects.toMatchObject({ code: "org_ceiling" });
    });

    it("does not charge parked or suspended sandboxes against task capacity", async () => {
      const c = await armedChild("parked-capacity");
      const db = api!.providers.db;
      for (let n = 0; n < MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR; n++) {
        await db.insert(agentSessions).values({ id: `parked-${n}`, userId: "local-user", orgId: "local-org", workspace: "/tmp",
          status: "hibernated", createdAt: 1, updatedAt: 1 });
        await db.insert(childWatches).values({ ...c.watch, childSessionId: `parked-${n}`, queueItemId: `parked-qi-${n}`,
          settled: true, parkedSandboxId: `sandbox-${n}`, createdAt: 1 });
      }
      const result = await buildChildSpawner(c.deps, c.watcher)({ prompt: "more" }, { parentSessionId: c.parent.id,
        parentThreadId: c.parentThread.id, actorUserId: "local-user", owner: { type: "user", id: "local-user" } });
      expect(result.childSessionId).toBeTruthy();
    });

    it("keeps a running signal's generation and narrow scope when queue:true admits send2", async () => {
      const c = await armedChild("running-signal-generation");
      await c.engineStore.createLease({ id: "running-signal-hold", sessionId: c.child.id, threadId: c.childThread.id,
        ownerKind: "hold", reason: "keep the fixture's live session", createdAt: Date.now(), deadlineAt: Date.now() + 60_000 });
      // The store owns the claimed test turn. Keep the live Thread from reconciling a claim it did not start.
      const prompt = vi.spyOn(c.child, "prompt").mockImplementation(async (content, options) => {
        expect(options?.queueMode).toBeDefined();
        const item = { ...queuedItem(`send-${options?.queueMode}`, c.childThread.id, ""), content, metadata: options?.metadata };
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, item);
        return { queueItemId: item.id, sessionId: c.child.id, threadId: c.childThread.id, status: "queued" };
      });
      const first = await buildChildSender(c.deps, c.watcher)({ childSessionId: c.child.id, message: "narrow work" },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user", toolScope: { tools: ["read"] } });
      const claim = (id: string) => ({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: `attempt-${id}`, ownerId: "test" });
      const finish = async (id: string) => {
        const fence = { itemId: id, attemptId: `attempt-${id}`, ownerId: "test" };
        await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "completed" }, fence);
        await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      };
      expect(await c.engineStore.claimSubmission(claim(first!.queueItemId))).not.toBeNull();
      await finish(first!.queueItemId);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("sig-running", c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.released", body: "hold released" }, metadata: { [INHERIT_TOOL_SCOPE_KEY]: true } });
      const sig = await c.engineStore.claimSubmission(claim("sig-running"));
      expect(sig?.metadata?.[CONTINUATION_SOURCE_ITEM_KEY]).toBe(first!.queueItemId);
      const second = await buildChildSender(c.deps, c.watcher)({ childSessionId: c.child.id, message: "broad work", queue: true },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user", toolScope: { tools: ["read", "bash"] } });
      await finish("sig-running");
      await c.watcher.observeTurn(c.child.id, "sig-running");
      const dispatch = `${c.child.id}:settled:${c.child.id}:sig-running`;
      await waitFor(async () => (await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch)) !== null);
      expect((await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch))?.metadata?.toolScope).toEqual({ tools: ["read"] });
      expect((await api!.providers.db.select().from(childWatches))[0]).toMatchObject({ queueItemId: second!.queueItemId, settled: false });
      expect((await c.engineStore.getQueueItem(c.child.id, second!.queueItemId))?.status).toBe("queued");
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, second!.queueItemId, { outcome: "completed" });
      await waitFor(c.settled);
      prompt.mockRestore();
    });

    it("skips fully-done history and isolates a broken recovery row", async () => {
      const c = await armedChild("recovery-isolation");
      const db = api!.providers.db;
      await db.insert(childWatches).values(Array.from({ length: 200 }, (_, n) => ({ ...c.watch, childSessionId: `history-${n}`,
        settled: true, deliveryActive: false, eventsStartedAt: 1, sandboxReclaimedAt: 1, createdAt: 1 })));
      await db.insert(childWatches).values({ ...c.watch, childSessionId: "a-broken", deliveryActive: true, createdAt: 1 });
      const get = c.engineStore.getSession.bind(c.engineStore);
      const spy = vi.spyOn(c.engineStore, "getSession").mockImplementation(async (id) => {
        if (id === "a-broken") throw new Error("bad recovery row");
        if (id.startsWith("history-")) throw new Error("historical row was read");
        return get(id);
      });
      const pending = vi.spyOn(c.engineStore, "listPendingChildResultsBefore");
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await c.watcher.rearm();
        await waitFor(c.settled);
        await c.watcher.retryOutbox();
        expect(pending.mock.calls.some(([id]) => id.startsWith("history-"))).toBe(false);
        expect(errors.mock.calls.some(args => String(args[0]).includes("a-broken"))).toBe(true);
        expect(spy.mock.calls.some(([id]) => id.startsWith("history-"))).toBe(false);
      } finally { spy.mockRestore(); pending.mockRestore(); errors.mockRestore(); }
    });

    it("serializes idle close with publication and checks the empty-buffer CAS", async () => {
      const c = await armedChild("close-publication");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.watcher.ensureSubscription(c.watch);
      const waiter = await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`);
      if (!waiter) throw new Error("waiter missing");
      let entered!: () => void;
      let release!: () => void;
      const atClose = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const transition = c.engineStore.transitionWakeup.bind(c.engineStore);
      const spy = vi.spyOn(c.engineStore, "transitionWakeup").mockImplementationOnce(async (...args) => {
        expect(args[5]).toEqual({ eventBufferEmpty: true });
        entered();
        await hold;
        return transition(...args);
      });
      const closing = c.watcher.closeSubscription(waiter);
      try {
        await atClose;
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("closing-sig", c.childThread.id, ""),
          content: { kind: "signal", signalType: "lease.released", body: "release" } });
        await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "closing-sig", { outcome: "failed", error: "racing result" });
        const publishing = c.watcher.observeTurn(c.child.id, "closing-sig");
        release();
        await closing;
        await publishing;
        await waitFor(async () => (await c.settledSignal())?.body === "racing result");
        expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
      } finally { release(); await closing; spy.mockRestore(); }
    });

    it("does not overtake an older outbox result and retries empty-buffer ingestion failures", async () => {
      const c = await armedChild("outbox-order", { retryDelayMs: 10 });
      c.watcher.arm(c.watch);
      const find = vi.spyOn(c.engineStore, "findEventWaiters").mockRejectedValue(new Error("ingest offline"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await vi.waitFor(async () => expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(1));
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("newer-sig", c.childThread.id, ""),
          content: { kind: "signal", signalType: "lease.released", body: "newer" } });
        await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "newer-sig", { outcome: "failed", error: "newer result" });
        await c.watcher.observeTurn(c.child.id, "newer-sig");
        await vi.waitFor(async () => expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(2));
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer ?? []).toEqual([]);
        find.mockRestore();
        // The retry timer must fill the empty buffer without another event or boot.
        await vi.waitFor(async () => {
          const buffer = (await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer;
          expect(buffer?.map(d => d.refs?.child_queue_item_id)).toEqual([c.watch.queueItemId, "newer-sig"]);
        }, { timeout: 5000 });
        await waitFor(c.settled);
      } finally { find.mockRestore(); errors.mockRestore(); }
    });

    it("cancellation removes the outbox and logs the abandoned reply before a new send", async () => {
      const c = await armedChild("cancel-outbox");
      c.watcher.arm(c.watch);
      await vi.waitFor(async () => expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(1));
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("cancelled-history", c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.released", body: "old work" } });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "cancelled-history", { outcome: "failed", error: "old result" });
      await cancelChildDelivery(api!.providers.db, c.engineStore, c.child.id, "Parent thread archived.");
      expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer).toEqual([]);
      expect(await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "child_delivery_cancelled"))).toHaveLength(1);
      const next = await buildChildSender(c.deps, c.watcher)({ childSessionId: c.child.id, message: "new cycle" },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user" });
      await c.watcher.rearm();
      await childDelivery!.sweep();
      expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:cancelled-history`)).toBeNull();
      expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:${c.watch.queueItemId}`)).toBeNull();
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, next!.queueItemId, { outcome: "completed" });
      await waitFor(c.settled);
    });

    it("does not replay legacy turns or reset retention after an automatic channel reply", async () => {
      const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" };
      const c = await armedChild("legacy-auto", {}, origin);
      const db = api!.providers.db;
      await db.update(childWatches).set({ originJson: JSON.stringify(origin), replyRoute: "origin" })
        .where(eq(childWatches.childSessionId, c.watch.childSessionId));
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
        ...queuedItem("legacy-signal", c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.expired", body: "old hold ended" },
      });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "legacy-signal", { outcome: "completed" });
      const settledAt = Date.now() - 48 * 3_600_000;
      const sandboxReclaimedAt = settledAt + 1;
      await db.update(childWatches).set({ eventsStartedAt: null, settledAt, sandboxReclaimedAt, parkedSandboxId: "already-destroyed" })
        .where(eq(childWatches.childSessionId, c.child.id));
      await c.engineStore.deleteWakeupRows(c.parent.id, { wakeupId: `wk_child_events:${c.child.id}` });
      const destroy = vi.spyOn(api!.providers.engineHost, "destroySandbox");
      await c.watcher.rearm();
      await c.watcher.rearm();
      await c.watcher.sweepRetention();
      expect(await c.engineStore.listUnsettledSubmissions(c.parent.id)).toHaveLength(1);
      expect(await db.select().from(childReplyDeliveries)).toHaveLength(1);
      expect((await db.select().from(childWatches))[0]).toMatchObject({ settledAt, sandboxReclaimedAt });
      expect(destroy).not.toHaveBeenCalled();
    });

    it("delivers a buffered old turn without settling the new child_send generation", async () => {
      const c = await armedChild("buffer-repoint");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
        ...queuedItem("sig-before-send", c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.released", body: "hold released" },
      });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "sig-before-send", { outcome: "failed", error: "old truthful result" });
      await c.watcher.observeTurn(c.child.id, "sig-before-send");
      await vi.waitFor(async () => expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer).toHaveLength(1));
      const receipt = await buildChildSender(c.deps, c.watcher)(
        { childSessionId: c.child.id, message: "new work" },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user" });
      await waitFor(async () => (await c.settledSignal())?.body === "old truthful result");
      expect((await api!.providers.db.select().from(childWatches))[0]).toMatchObject({ queueItemId: receipt?.queueItemId, settled: false });
      expect((await c.engineStore.getQueueItem(c.child.id, receipt!.queueItemId))?.status).not.toBe("settled");
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, receipt!.queueItemId, { outcome: "completed" });
      await waitFor(c.settled);
    });

    it("keeps the child_send scope on a later hold signal turn", async () => {
      const c = await armedChild("scope-later");
      const receipt = await buildChildSender(c.deps, c.watcher)(
        { childSessionId: c.child.id, message: "read only" },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user", toolScope: { tools: ["read"] } });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, receipt!.queueItemId, { outcome: "completed" });
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
        ...queuedItem("scope-hold-turn", c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.expired", body: "hold expired" },
      });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "scope-hold-turn", { outcome: "completed" });
      await c.watcher.observeTurn(c.child.id, "scope-hold-turn");
      const dispatchId = `${c.child.id}:settled:${c.child.id}:scope-hold-turn`;
      await waitFor(async () => (await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatchId)) !== null);
      expect((await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatchId))?.metadata?.toolScope).toEqual({ tools: ["read"] });
    });

    it.each(["cancelled", "done"] as const)("child_send restores a %s subscription", async (status) => {
      const c = await armedChild(`restore-${status}`);
      await c.watcher.ensureSubscription(c.watch);
      await c.engineStore.transitionWakeup(`wk_child_events:${c.child.id}`, ["running"], status, {}, Date.now());
      const receipt = await buildChildSender(c.deps, c.watcher)(
        { childSessionId: c.child.id, message: "resume" },
        { parentSessionId: c.parent.id, parentThreadId: c.parentThread.id, actorUserId: "local-user" });
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("running");
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, receipt!.queueItemId, { outcome: "completed" });
      await waitFor(c.settled);
      expect(await c.settledSignal()).toBeDefined();
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("done");
    });

    it("drains more than 200 turns without a boot and reserves room for a gate", async () => {
      const c = await armedChild("overflow");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        for (let n = 0; n < 205; n++) {
          const id = `overflow-${n}`;
          await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
            ...queuedItem(id, c.childThread.id, ""), content: { kind: "signal", signalType: "event.matched", body: id },
          });
          await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, id, { outcome: "failed", error: id });
          await c.watcher.observeTurn(c.child.id, id);
        }
        await vi.waitFor(async () => expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(205), { timeout: 15_000 });
        const gate = { id: "overflow-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
          resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Continue?", actions: [], status: "pending" as const,
          createdAt: Date.now(), updatedAt: Date.now() };
        await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
        await c.watcher.reportGateOpened(c.child.id, gate);
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer?.some(d => d.key === "child.gate_opened")).toBe(true);
        await childDelivery!.sweep();
        expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)).not.toBeNull();
        for (let n = 0; n < 15; n++) {
          for (const item of await c.engineStore.listUnsettledSubmissions(c.parent.id)) {
            await c.engineStore.settleUnclaimed(c.parent.id, c.parentThread.id, item.id, { outcome: "completed" });
          }
          await childDelivery!.sweep();
        }
        expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
        const delivered = [...await c.engineStore.listSettledSubmissionsBefore(c.parent.id, Date.now() + 1),
          ...await c.engineStore.listUnsettledSubmissions(c.parent.id)];
        expect(delivered).toHaveLength(207);
        const drops = await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "pending_cap"));
        expect(drops).toHaveLength(1);
      } finally { errors.mockRestore(); warns.mockRestore(); }
    });

    it("writes one pending-cap diagnostic per incident instead of per subscription", async () => {
      const c = await armedChild("pending-incidents");
      c.watcher.arm(c.watch);
      await vi.waitFor(async () => expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer).toHaveLength(1));
      const get = c.engineStore.admitSubmission.bind(c.engineStore);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const blocked = vi.spyOn(c.engineStore, "admitSubmission").mockImplementation(async (...args) => {
        if (args[0] === c.parent.id) throw new PendingCapError(c.parentThread.id, 20);
        return get(...args);
      });
      try {
        await childDelivery!.sweep();
        await childDelivery!.sweep();
        expect(await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "pending_cap"))).toHaveLength(1);
        blocked.mockRestore();
        await waitFor(c.settled);
        expect((await api!.providers.db.select().from(childWatches))[0]?.pendingCapIncident).toBeNull();
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("incident2", c.childThread.id, ""),
          content: { kind: "signal", signalType: "event.matched", body: "more work" } });
        await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "incident2", { outcome: "failed", error: "new result" });
        await c.watcher.observeTurn(c.child.id, "incident2");
        await vi.waitFor(async () => expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventBuffer).toHaveLength(1));
        const blockedAgain = vi.spyOn(c.engineStore, "admitSubmission").mockImplementation(async (...args) => {
          if (args[0] === c.parent.id) throw new PendingCapError(c.parentThread.id, 20);
          return get(...args);
        });
        try {
          await childDelivery!.sweep();
          await childDelivery!.sweep();
          expect(await api!.providers.db.select().from(eventDropLog).where(eq(eventDropLog.reason, "pending_cap"))).toHaveLength(2);
        } finally { blockedAgain.mockRestore(); }
        await childDelivery!.sweep();
      } finally { blocked.mockRestore(); errors.mockRestore(); }
    });

    it("reports deferred cancellation after a forced replacement starts provisioning", async () => {
      const c = await armedChild("replace-provisioning");
      const state = vi.spyOn(c.child.attachment, "state", "get").mockReturnValue("provisioning");
      try {
        c.watcher.arm(c.watch);
        await waitFor(c.settled);
        expect(api!.providers.engineHost.liveSession(c.child.id)).not.toBeNull();
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
          ...queuedItem("replacement-cancel", c.childThread.id, ""),
          content: { kind: "signal", signalType: "process.exited", body: "A person replaced the sandbox." },
        });
        await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "replacement-cancel", { outcome: "failed", error: "replacement result" });
        await c.watcher.observeTurn(c.child.id, "replacement-cancel");
        await waitFor(async () => (await c.settledSignal())?.body === "replacement result");
        expect(api!.providers.engineHost.liveSession(c.child.id)).not.toBeNull();
      } finally { state.mockRestore(); }
    });

    it("keeps internal events out of org receipts and user subscriptions", async () => {
      const c = await armedChild("internal-only");
      const db = api!.providers.db;
      await db.insert(eventSubscriptions).values({ id: "user-child-sub", orgId: "local-org", ownerType: "user", ownerId: "local-user",
        createdBy: "local-user", name: "Catch children", eventKeys: ["child.*"], filters: [], target: { kind: "assistant" }, enabled: true,
        createdAt: 1, updatedAt: 1 });
      await c.engineStore.createWakeup({ id: "wk_user-child", sessionId: c.parent.id, threadId: c.parentThread.id,
        kind: "event", status: "running", reason: "user event wait", subjects: [`valet:session:${c.child.id}`],
        eventMatch: { clauses: [{ key: "child.*" }], self: [], once: true }, deadlineAt: Date.now() + 60_000,
        logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1 });
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      expect((await c.engineStore.getWakeup("wk_user-child"))?.eventBuffer ?? []).toEqual([]);
      expect(await db.select().from(eventReceipts)).toEqual([]);
      expect(await db.select().from(events)).toEqual([]);
      expect(await db.select().from(eventDeliveries)).toEqual([]);
    });

    it.each(["cancel", "archive", "move"] as const)("new bot repro 1: %s completes before a buffered gate lookup returns", async mode => {
      const c = await armedChild(`cancel-inflight-${mode}`);
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const gate = { id: "cancel-inflight-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Must not arrive after cancellation", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      await c.watcher.reportGateOpened(c.child.id, gate);
      const get = c.engineStore.getDecisionGate.bind(c.engineStore);
      const lookup = vi.spyOn(c.engineStore, "getDecisionGate").mockImplementationOnce(async (session, id) => {
        const pending = await get(session, id);
        if (mode === "cancel") await cancelChildDelivery(api!.providers.db, c.engineStore, c.child.id, "Delivery cancelled during gate lookup");
        else await endChildSubscriptions(c.engineStore, c.parent.id, mode === "archive" ? c.parentThread.id : undefined, api!.providers.db);
        return pending;
      });
      try {
        await childDelivery!.sweep();
        expect(lookup).toHaveBeenCalled();
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("cancelled");
        expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)).toBeNull();
      } finally { lookup.mockRestore(); }
    });

    it("rereads a gate resolved before acquiring the delivery lock", async () => {
      const c = await armedChild("resolved-before-lock");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const gate = { id: "resolved-before-lock", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Already resolved", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      await c.watcher.reportGateOpened(c.child.id, gate);
      const get = c.engineStore.getDecisionGate.bind(c.engineStore);
      const lookup = vi.spyOn(c.engineStore, "getDecisionGate").mockImplementationOnce(async (session, id) => {
        const pending = await get(session, id);
        await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, { ...gate, status: "resolved" });
        return pending;
      });
      try {
        await childDelivery!.sweep();
        expect(lookup).toHaveBeenCalled();
        expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)).toBeNull();
      } finally { lookup.mockRestore(); }
    });

    it("does not admit a stale gate digest after cancellation and explicit reactivation", async () => {
      const c = await armedChild("cancel-reactivate-gate");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const gate = { id: "stale-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Cancelled cycle", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      await c.watcher.reportGateOpened(c.child.id, gate);
      const get = c.engineStore.getDecisionGate.bind(c.engineStore);
      const lookup = vi.spyOn(c.engineStore, "getDecisionGate").mockImplementationOnce(async (session, id) => {
        const pending = await get(session, id);
        await cancelChildDelivery(api!.providers.db, c.engineStore, c.child.id, "End the old delivery cycle");
        await c.watcher.ensureSubscription(c.watch, true);
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("running");
        return pending;
      });
      try {
        await childDelivery!.sweep();
        expect(lookup).toHaveBeenCalled();
        expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)).toBeNull();
      } finally { lookup.mockRestore(); }
    });

    it.each(["gate", "settlement"] as const)("new bot repro 2: the first private submission protects its own %s route", async event => {
      const c = await armedChild(`private-own-${event}`);
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await api!.providers.db.update(childWatches).set({ replyRoute: "origin",
        originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }) })
        .where(eq(childWatches.childSessionId, c.child.id));
      const id = "first-private-web-turn";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id,
        { ...queuedItem(id, c.childThread.id, "Private acquisition numbers"), author: { id: "local-user" } });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: "private", ownerId: "test" });
      await c.engineStore.appendEntries(c.child.id, c.childThread.id, [{ id: "first-private-entry", sessionId: c.child.id,
        threadId: c.childThread.id, queueItemId: id, parentId: null, type: "message", role: "user", content: "Private acquisition numbers", createdAt: Date.now() }]);
      if (event === "gate") {
        const gate = { id: "first-private-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: id,
          resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "SECRET acquisition approval", actions: [], status: "pending" as const,
          createdAt: Date.now(), updatedAt: Date.now() };
        await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
        await c.watcher.reportGateOpened(c.child.id, gate);
        const dispatch = `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`;
        await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch) !== null);
        const content = (await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch))?.content;
        expect(content).not.toHaveProperty("origin");
        expect(JSON.stringify(content)).not.toContain(gate.title);
      } else {
        const fence = { itemId: id, attemptId: "private" };
        await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "completed" }, fence);
        await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
        await api!.providers.db.update(childWatches).set({ queueItemId: id, settled: false }).where(eq(childWatches.childSessionId, c.child.id));
        c.watcher.arm({ ...c.watch, queueItemId: id });
        const dispatch = `${c.child.id}:settled:${c.child.id}:${id}`;
        await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch) !== null);
        expect((await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch))?.content).toMatchObject({ origin: { reply: "manual" } });
        expect(await api!.providers.db.select().from(childReplyDeliveries).where(eq(childReplyDeliveries.id, dispatch))).toHaveLength(0);
      }
    });

    it("bot repro 1: redacts a taken-over gate and omits the saved Slack origin", async () => {
      const c = await armedChild("bot-gate-privacy");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await api!.providers.db.update(childWatches).set({ replyRoute: "none",
        originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }) })
        .where(eq(childWatches.childSessionId, c.child.id));
      const id = "web-private";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id,
        { ...queuedItem(id, c.childThread.id, "Private web work"), author: { id: "local-user" } });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: "web", ownerId: "test" });
      const gate = { id: "private-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: id,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "SECRET acquisition approval", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      expect(await childGateOrigin(api!.providers.db, c.engineStore, c.child.id, id)).toBeUndefined();
      await c.watcher.reportGateOpened(c.child.id, gate);
      const dispatch = `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`;
      await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch) !== null);
      const content = (await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch))?.content;
      expect(content).not.toHaveProperty("origin");
      expect(JSON.stringify(content)).not.toContain(gate.title);
    });

    it.each(["archive", "move", "run-archive"] as const)("bot repro 2: %s cancels an idle subscription before a later gate", async mode => {
      const c = await armedChild(`bot-idle-${mode}`);
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("done");
      if (mode === "archive") {
        for (const item of await c.engineStore.listUnsettledSubmissions(c.parent.id)) {
          await c.engineStore.settleUnclaimed(c.parent.id, c.parentThread.id, item.id, { outcome: "completed" });
        }
        await api!.providers.db.insert(agentSessions).values({ id: c.parent.id, userId: "local-user", orgId: "local-org",
          workspace: "/tmp", status: "active", ownerType: "user", ownerId: "local-user", createdAt: Date.now(), updatedAt: Date.now() });
        const response = await fetch(`${api!.baseUrl}/api/sessions/${c.parent.id}/threads/${c.parentThread.id}`,
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
        expect(response.status).toBe(200);
      } else await endChildSubscriptions(c.engineStore, c.parent.id, mode === "move" ? undefined : c.parentThread.id, api!.providers.db);
      const gate = { id: "after-archive", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Must not reach archived parent", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      await c.watcher.reportGateOpened(c.child.id, gate);
      await childDelivery!.sweep();
      expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)).toBeNull();
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("cancelled");
    });

    it.each(["observer", "reboot"] as const)("bot repro 4: queued child_send preserves the running delegation result and its narrow scope through %s", async via => {
      const c = await armedChild("bot-running-delegation");
      await c.engineStore.createLease({ id: "bot-hold", sessionId: c.child.id, ownerKind: "hold", reason: "retain fixture",
        createdAt: Date.now(), deadlineAt: Date.now() + 60_000 });
      const prompt = vi.spyOn(c.child, "prompt").mockImplementation(async (content, options) => {
        const item = { ...queuedItem(`send-${options?.queueMode}`, c.childThread.id, ""), content, metadata: options?.metadata };
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, item);
        return { queueItemId: item.id, sessionId: c.child.id, threadId: c.childThread.id, status: "queued" };
      });
      const arm = via === "reboot" ? vi.spyOn(c.watcher, "arm").mockImplementation(() => undefined) : undefined;
      try {
        const send = buildChildSender(c.deps, c.watcher);
        const a = await send({ childSessionId: c.child.id, message: "A" }, { parentSessionId: c.parent.id,
          parentThreadId: c.parentThread.id, actorUserId: "local-user", toolScope: { tools: ["read"] } });
        if (!a) throw new Error("Missing A");
        await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: a.queueItemId, attemptId: "A", ownerId: "test" });
        const b = await send({ childSessionId: c.child.id, message: "B", queue: true }, { parentSessionId: c.parent.id,
          parentThreadId: c.parentThread.id, actorUserId: "local-user", toolScope: { tools: ["read", "bash"] } });
        if (!b) throw new Error("Missing B");
        const fence = { itemId: a.queueItemId, attemptId: "A" };
        await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, a.queueItemId, { outcome: "failed", error: "A truthful result" }, fence);
        await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, a.queueItemId, fence);
        if (via === "observer") await c.watcher.observeTurn(c.child.id, a.queueItemId);
        else await testChildWatcher(c.deps).rearm();
        await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id,
          `${c.child.id}:settled:${c.child.id}:${a.queueItemId}`) !== null);
        expect((await api!.providers.db.select().from(childWatches))[0]).toMatchObject({ queueItemId: b.queueItemId, settled: false });
        await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, b.queueItemId, { outcome: "failed", error: "B result" });
        await waitFor(c.settled);
        const resultA = await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:${a.queueItemId}`);
        const resultB = await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:${b.queueItemId}`);
        expect(resultA?.content).toMatchObject({ body: expect.stringContaining("A truthful result") });
        expect(resultA?.metadata?.toolScope).toEqual({ tools: ["read"] });
        expect(resultB?.content).toMatchObject({ body: expect.stringContaining("B result") });
      } finally { prompt.mockRestore(); arm?.mockRestore(); }
    });

    it("reports a pending gate even after the child was notified as settled", async () => {
      const c = await armedChild("settled-gate");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const gate = { id: "settled-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: c.watch.queueItemId,
        resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Continue?", actions: [], status: "pending" as const,
        createdAt: Date.now(), updatedAt: Date.now() };
      await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
      await c.watcher.reportGateOpened(c.child.id, gate);
      await waitFor(async () => (await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`)) !== null);
    });

    it("restores ingestion when the previous turn ends its waiter during publication", async () => {
      const c = await armedChild("idle-publish-race");
      const find = c.engineStore.findEventWaiters.bind(c.engineStore);
      const spy = vi.spyOn(c.engineStore, "findEventWaiters").mockImplementationOnce(async (subjects) => {
        const rows = await find(subjects);
        await c.engineStore.transitionWakeup(`wk_child_events:${c.child.id}`, ["running"], "done", {}, Date.now());
        return rows;
      });
      try {
        c.watcher.arm(c.watch);
        await waitFor(c.settled);
        expect(await c.settledSignal()).toBeDefined();
      } finally { spy.mockRestore(); }
    });

    it("nudges delivery without waiting for the full sweep", async () => {
      const c = await armedChild("nudge");
      const driver = childDelivery!;
      driver.start();
      const watcher = new ChildWatcher({ ...c.deps, nudgeChildEvents: (ids) => driver.nudge(ids) });
      try {
        watcher.arm(c.watch);
        await vi.waitFor(async () => expect(await c.settled()).toBe(true), { timeout: 3000 });
      } finally { await driver.stop(); }
    });

    it.each(["lease.expired", "lease.released"])("reports a later %s turn", async (signalType) => {
      const c = await armedChild(signalType);
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, {
        ...queuedItem("hold-ended", c.childThread.id, ""), content: { kind: "signal", signalType, body: "hold ended" },
      });
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, "hold-ended", { outcome: "failed", error: "hold response" });
      await c.watcher.observeTurn(c.child.id, "hold-ended");
      await waitFor(async () => (await c.settledSignal())?.body === "hold response");
    });

    it.each(["process", "watch", "hold", "timer", "event"] as const)(
      "notifies with outstanding %s work and keeps the sandbox",
      async (kind) => {
        const c = await armedChild(`background-${kind}`);
        const now = (await c.engineStore.getQueueItem(c.child.id, c.watch.queueItemId))!.updatedAt;
        // This work was created by the completed turn, not after its settlement.
        const sourceQueueItemId = c.watch.queueItemId;
        const deadline = now + 7 * 24 * 3_600_000;
        if (kind === "timer" || kind === "event") {
          await c.engineStore.createWakeup({
            id: "outstanding", sourceQueueItemId, sessionId: c.watch.childSessionId, threadId: c.childThread.id,
            kind, status: kind === "timer" ? "pending" : "running", reason: "CI result",
            ...(kind === "timer" ? { fireAt: deadline, prompt: "check CI" } : {
              deadlineAt: deadline, subjects: ["github:acme/repo#42"],
              eventMatch: { clauses: [{ key: "github.check_run.completed" }], once: true, self: [] },
            }),
            logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now,
          });
        } else {
          await c.engineStore.createLease({ id: "outstanding", sourceQueueItemId, sessionId: c.watch.childSessionId,
            ownerKind: kind, ...(kind !== "hold" ? { ownerId: "lease-owner" } : {}), reason: "CI result", deadlineAt: deadline, createdAt: now });
          if (kind !== "hold") await c.engineStore.createWakeup({
            id: "lease-owner", sourceQueueItemId, sessionId: c.watch.childSessionId, threadId: c.childThread.id, kind,
            status: "pending", reason: "CI result", leaseId: "outstanding", deadlineAt: deadline,
            logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now,
          });
        }
        c.watcher.arm(c.watch);
        await waitFor(c.settled);
        expect((await c.settledSignal())?.body).toContain("CI result");
        expect(JSON.parse((await c.settledSignal())?.attributes?.background_work ?? "null")).toEqual([
          { id: "outstanding", kind, reason: "CI result", deadline: new Date(deadline).toISOString() },
        ]);
        expect(api?.providers.engineHost.liveSession(c.watch.childSessionId)).not.toBeNull();
        const subscription = await c.engineStore.getWakeup(`wk_child_events:${c.watch.childSessionId}`);
        expect(subscription).toMatchObject({ kind: "event", status: "running", sessionId: c.watch.parentSessionId,
          threadId: c.watch.parentThreadId, subjects: [`valet:session:${c.watch.childSessionId}`] });
        expect(subscription?.deadlineAt).toBeUndefined();
      },
    );

    it("reports a later signal turn with its own dispatch id and result", async () => {
      const c = await armedChild("later-turn");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const itemId = "later-signal";
      await c.engineStore.admitSubmission(c.watch.childSessionId, c.childThread.id, {
        ...queuedItem(itemId, c.childThread.id, ""),
        content: { kind: "signal", signalType: "event.matched", body: "CI finished" },
      });
      expect((await resolveChildSettlement(childrenDeps(api!), c.watch.childSessionId, c.watch.parentSessionId))?.settled).toBe(false);
      await c.engineStore.settleUnclaimed(c.watch.childSessionId, c.childThread.id, itemId, { outcome: "failed", error: "CI is red" });
      await c.watcher.observeTurn(c.watch.childSessionId, itemId);
      await waitFor(async () => (await c.settledSignal())?.body === "CI is red");
      const signals = (await c.engineStore.listUnsettledSubmissions(c.watch.parentSessionId)).filter((q) =>
        typeof q.content === "object" && q.content !== null && "signalType" in q.content && q.content.signalType === "child.settled");
      expect(signals).toHaveLength(2);
      expect(signals[1]?.dispatchId).toBe(`${c.watch.childSessionId}:settled:${c.watch.childSessionId}:${itemId}`);
      await testChildWatcher(childrenDeps(api!)).rearm();
      await childDelivery?.sweep();
      expect(await c.engineStore.listUnsettledSubmissions(c.watch.parentSessionId)).toHaveLength(2);
    });

    it("does not resurrect a permanently denied signal result after reboot or block later updates", async () => {
      const c = await armedChild("denied-reboot", {}, { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" });
      const db = api!.providers.db;
      await db.update(childWatches).set({ originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1", reply: "auto" }), replyRoute: "origin" })
        .where(eq(childWatches.childSessionId, c.child.id));
      await c.engineStore.createWakeup({ id: "wk_child_wait", sessionId: c.child.id, threadId: c.childThread.id,
        kind: "event", status: "running", reason: "wait_for_event", subjects: ["github:tkhq/valet#1030"],
        deadlineAt: Date.now() + 60_000, eventMatch: { clauses: [{ key: "github.pull_request.*" }], self: [], once: false },
        logOffset: 0, logTail: "", eventCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
      c.parent.options.signalHopBudget = 0;
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const signal = async (id: string) => {
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, ""),
          content: { kind: "signal", signalType: "event.matched", body: id } });
        const claimed = await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id,
          itemId: id, attemptId: `attempt-${id}`, ownerId: "test" });
        expect(claimed?.childResultDelivery).toBe("pending");
        const fence = { itemId: id, attemptId: `attempt-${id}` };
        await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "failed", error: id }, fence);
        await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
        await c.watcher.observeTurn(c.child.id, id);
      };
      await signal("denied-signal");
      await vi.waitFor(async () => expect(await db.select().from(childEventOutbox)).toHaveLength(1));
      const [deniedEvent] = await db.select().from(childEventOutbox);
      await childDelivery!.sweep();
      expect((await c.engineStore.getQueueItem(c.child.id, "denied-signal"))?.childResultDelivery).toBe("denied");
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.eventSourceSeen).toContain(deniedEvent!.id);
      expect(await db.select().from(childEventOutbox)).toHaveLength(0);
      expect((await db.select().from(eventDropLog)).filter(row => row.reason === "hop_budget")).toHaveLength(2);

      const reboot = testChildWatcher(c.deps);
      await reboot.rearm();
      expect(await db.select().from(childEventOutbox)).toHaveLength(0);
      c.parent.options.signalHopBudget = 8;
      // A legacy or crash-left outbox row can still name a consumed source.
      // Clear the durable outcome to exercise the drain's seen-list fallback separately.
      await db.execute(sql`UPDATE engine_queue_items SET child_result_delivery = NULL WHERE id = 'denied-signal'`);
      await db.insert(childEventOutbox).values(deniedEvent!);
      await signal("later-result");
      await waitFor(async () => (await c.settledSignal())?.body.includes("later-result") === true);
      await reboot.rearm();
      await childDelivery!.sweep();
      expect(await db.select().from(childEventOutbox)).toHaveLength(0);
      expect((await c.engineStore.getQueueItem(c.child.id, "denied-signal"))?.childResultDelivery).toBe("denied");
      expect((await c.engineStore.getQueueItem(c.child.id, "later-result"))?.childResultDelivery).toBe("delivered");
      expect(await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:denied-signal`)).toBeNull();
      expect((await db.select().from(childReplyDeliveries)).find(row => row.childQueueItemId === "later-result")?.queueItemId).toBeTruthy();
    });

    it.each(["observer", "recovery", "retry"] as const)("review boundary repro: %s excludes later private background work", async via => {
      const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" };
      const c = await armedChild(`private-work-${via}`, {}, origin);
      const db = api!.providers.db;
      await db.update(childWatches).set({ originJson: JSON.stringify(origin), replyRoute: "origin" })
        .where(eq(childWatches.childSessionId, c.child.id));
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const id = "public-turn";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, "public task"),
        metadata: parentDelegationMetadata(c.parent.id, c.parentThread.id, origin) });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: "public", ownerId: "test" });
      await c.engineStore.appendEntries(c.child.id, c.childThread.id, [{ id: "public-entry", type: "message", role: "user", content: "public task",
        sessionId: c.child.id, threadId: c.childThread.id, queueItemId: id, parentId: null, createdAt: Date.now() }]);
      const fence = { itemId: id, attemptId: "public" };
      await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "failed", error: "Public result" }, fence);
      await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      const boundary = (await c.engineStore.getQueueItem(c.child.id, id))!.updatedAt;
      let claimed = false;
      const privateWork = async () => {
        if (claimed) return;
        claimed = true;
        const privateId = "private-web-turn";
        await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(privateId, c.childThread.id, "private request"), author: { id: "local-user" } });
        await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: privateId, attemptId: "private", ownerId: "test" });
        await c.engineStore.appendEntries(c.child.id, c.childThread.id, [{ id: "private-entry", type: "message", role: "user", content: "private request",
          sessionId: c.child.id, threadId: c.childThread.id, queueItemId: privateId, parentId: null, createdAt: boundary + 1 }]);
        await c.engineStore.createLease({ id: "ls_confidential", sessionId: c.child.id, threadId: c.childThread.id, ownerKind: "hold",
          reason: "CONFIDENTIAL acquisition price: $42 million", createdAt: boundary + 1, deadlineAt: boundary + 60_000 });
      };
      const list = c.engineStore.listActiveLeases.bind(c.engineStore);
      const racingClaim = via === "observer" ? vi.spyOn(c.engineStore, "listActiveLeases").mockImplementation(async child => {
        if (child === c.child.id) await privateWork();
        return list(child);
      }) : undefined;
      const prompt = via === "retry" ? vi.spyOn(c.parentThread, "submitPrompt").mockRejectedValue(new Error("temporary parent admission failure")) : undefined;
      try {
        if (via !== "observer") await privateWork();
        if (via === "recovery") await testChildWatcher(c.deps).rearm();
        else await c.watcher.observeTurn(c.child.id, id);
        const dispatchId = `${c.child.id}:settled:${c.child.id}:${id}`;
        if (via === "retry") {
          await vi.waitFor(async () => {
            await childDelivery!.sweep();
            expect(prompt).toHaveBeenCalled();
          });
          prompt?.mockRestore();
          await c.watcher.retryOutbox();
        }
        await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatchId) !== null);
        const result = await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatchId);
        expect(result?.content).toMatchObject({ origin: { reply: "auto" } });
        expect(JSON.stringify(result?.content)).not.toContain("CONFIDENTIAL");
        expect(JSON.stringify(result?.content)).not.toContain("ls_confidential");
        const gate = { id: "public-gate", sessionId: c.child.id, threadId: c.childThread.id, queueItemId: id,
          resumeKey: "rk", ordinal: 0, type: "approval" as const, title: "Public approval", actions: [], status: "pending" as const,
          createdAt: boundary, updatedAt: boundary };
        await c.engineStore.saveDecisionGate(c.child.id, c.childThread.id, gate);
        await c.watcher.reportGateOpened(c.child.id, gate);
        const gateDispatch = `${c.child.id}:gate-opened:${c.child.id}:${gate.id}`;
        await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, gateDispatch) !== null);
        const gateSignal = await c.engineStore.getQueueItemByDispatchId(c.parent.id, gateDispatch);
        expect(JSON.stringify(gateSignal?.content)).not.toContain("CONFIDENTIAL");
        expect(JSON.stringify(gateSignal?.content)).not.toContain("ls_confidential");
      } finally { racingClaim?.mockRestore(); prompt?.mockRestore(); }
    });

    it("redacts an earlier private creator's reason from a later public result", async () => {
      const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" };
      const c = await armedChild("private-work-reason", {}, origin);
      await api!.providers.db.update(childWatches).set({ originJson: JSON.stringify(origin), replyRoute: "origin" })
        .where(eq(childWatches.childSessionId, c.child.id));
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const privateId = "earlier-private";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(privateId, c.childThread.id, "private work"), author: { id: "local-user" } });
      await c.engineStore.appendEntries(c.child.id, c.childThread.id, [{ id: "private-work-entry", type: "message", role: "user", content: "private work",
        sessionId: c.child.id, threadId: c.childThread.id, queueItemId: privateId, parentId: null, createdAt: Date.now() }]);
      await c.engineStore.settleUnclaimed(c.child.id, c.childThread.id, privateId, { outcome: "failed", error: "private result" });
      const createdAt = (await c.engineStore.getQueueItem(c.child.id, privateId))!.updatedAt;
      await c.engineStore.createLease({ id: "earlier-private-hold", sessionId: c.child.id, threadId: c.childThread.id, sourceQueueItemId: privateId,
        ownerKind: "hold", reason: "CONFIDENTIAL price", createdAt, deadlineAt: createdAt + 60_000 });
      const publicThread = c.child.thread("public-followup");
      const id = "later-public";
      await c.engineStore.admitSubmission(c.child.id, publicThread.id, { ...queuedItem(id, publicThread.id, "public work"),
        metadata: parentDelegationMetadata(c.parent.id, c.parentThread.id, origin) });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: publicThread.id, itemId: id, attemptId: "public", ownerId: "test" });
      const fence = { itemId: id, attemptId: "public" };
      await c.engineStore.reserveSettlement(c.child.id, publicThread.id, id, { outcome: "failed", error: "public result" }, fence);
      const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt + 10);
      try { await c.engineStore.finalizeSettlement(c.child.id, publicThread.id, id, fence); }
      finally { clock.mockRestore(); }
      // Unknown legacy work can still be listed, but never with a channel-visible reason.
      await c.engineStore.createLease({ id: "legacy-private-hold", sessionId: c.child.id, ownerKind: "hold", reason: "CONFIDENTIAL legacy reason",
        createdAt: createdAt - 1, deadlineAt: createdAt + 60_000 });
      await c.watcher.observeTurn(c.child.id, id);
      const dispatch = `${c.child.id}:settled:${c.child.id}:${id}`;
      await waitFor(async () => await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch) !== null);
      const result = await c.engineStore.getQueueItemByDispatchId(c.parent.id, dispatch);
      expect(JSON.stringify(result?.content)).not.toContain("CONFIDENTIAL");
      expect(JSON.stringify(result?.content)).toContain("Private background work");
      expect(JSON.stringify(result?.content)).toContain("legacy-private-hold");
      expect(JSON.stringify(result?.content)).toContain("earlier-private-hold");
    });

    it("review runtime repro: a failed settlement event append is recovered without rearm", async () => {
      const c = await armedChild("missed-runtime-event");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const id = "missed-signal";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, ""),
        content: { kind: "signal", signalType: "timer.fired", body: "Continue" } });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: "signal", ownerId: "test" });
      const fence = { itemId: id, attemptId: "signal" };
      await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "failed", error: "Recovered at runtime" }, fence);
      await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      const recoveredMetric = vi.spyOn(engineMetrics, "recordChildResultRecovered").mockImplementation(() => undefined);
      const append = vi.spyOn(api!.providers.eventStream, "append").mockRejectedValueOnce(new Error("connection reset"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await c.child.emit({ type: "submission_settled", sessionId: c.child.id, threadId: c.childThread.id,
          queueItemId: id, outcome: { outcome: "failed", error: "Recovered at runtime" } }, { eventKey: `settled:${id}`, queueItemId: id });
        expect(append).toHaveBeenCalled();
        append.mockRestore();
        expect((await c.engineStore.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("pending");
        expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
        await c.watcher.retryOutbox();
        expect((await c.engineStore.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("pending");
        const pending = vi.spyOn(c.engineStore, "listPendingChildResultsBefore");
        const later = Date.now() + 60_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(later);
        try { await c.watcher.retryOutbox(); } finally { clock.mockRestore(); }
        expect(pending).toHaveBeenCalledWith(c.child.id, later - 30_000);
        pending.mockRestore();
        await childDelivery!.sweep();
        const recovered = await c.engineStore.getQueueItemByDispatchId(c.parent.id, `${c.child.id}:settled:${c.child.id}:${id}`);
        expect(recovered?.content).toMatchObject({ body: "Recovered at runtime" });
        expect((await c.engineStore.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("delivered");
        await c.watcher.retryOutbox();
        expect((await c.engineStore.listUnsettledSubmissions(c.parent.id)).filter(item => item.dispatchId === `${c.child.id}:settled:${c.child.id}:${id}`)).toHaveLength(1);
        expect(recoveredMetric).toHaveBeenCalledTimes(1);
      } finally { append.mockRestore(); errors.mockRestore(); recoveredMetric.mockRestore(); }
    });

    it("recovers a claimed signal that settles after idle close but crashes before publication", async () => {
      const c = await armedChild("closed-unpublished");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const waiterId = `wk_child_events:${c.child.id}`;
      expect((await c.engineStore.getWakeup(waiterId))?.status).toBe("done");
      expect((await api!.providers.db.select().from(childWatches))[0]?.deliveryActive).toBe(false);
      const id = "unpublished-signal";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, ""),
        content: { kind: "signal", signalType: "lease.released", body: "hold ended" } });
      const claimed = await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id,
        itemId: id, attemptId: "unpublished-attempt", ownerId: "test" });
      expect(claimed?.childResultDelivery).toBe("pending");
      const fence = { itemId: id, attemptId: "unpublished-attempt" };
      await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "failed", error: "recovered result" }, fence);
      await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
      const reboot = testChildWatcher(c.deps);
      await reboot.rearm();
      await waitFor(async () => (await c.settledSignal())?.body === "recovered result");
      expect((await c.engineStore.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("delivered");
      expect((await c.engineStore.getWakeup(waiterId))?.status).toBe("done");
      await reboot.rearm();
      await childDelivery!.sweep();
      expect(await c.engineStore.listUnsettledSubmissions(c.parent.id)).toHaveLength(2);
    });

    it("drop-logs a hop-budget denial on event delivery", async () => {
      const c = await armedChild("hop-budget");
      const parent = api!.providers.engineHost.liveSession(c.watch.parentSessionId);
      if (!parent) throw new Error("Missing parent session.");
      parent.options.signalHopBudget = 0;
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      expect(await c.settledSignal()).toBeUndefined();
      const drops = await api!.providers.db.select().from(eventDropLog);
      expect(drops).toHaveLength(1);
      expect(drops[0]?.reason).toBe("hop_budget");
    });

    it("recreates a missing parent waiter at boot and delivers through its buffer", async () => {
      const c = await armedChild("missing-waiter");
      c.watcher.arm(c.watch);
      await vi.waitFor(async () => {
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.watch.childSessionId}`))?.eventBuffer).toHaveLength(1);
      });
      expect(await c.settledSignal()).toBeUndefined();
      await c.engineStore.deleteWakeupRows(c.watch.parentSessionId, { wakeupId: `wk_child_events:${c.watch.childSessionId}` });
      const reboot = testChildWatcher(childrenDeps(api!));
      await reboot.rearm();
      await waitFor(c.settled);
      expect(await c.settledSignal()).toBeDefined();
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.watch.childSessionId}`))?.status).toBe("done");
    });

    it("does not report an injected signal as a separate completed turn", async () => {
      const c = await armedChild("merged-signal");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.watch.childSessionId, c.childThread.id, {
        ...queuedItem("merged-signal", c.childThread.id, ""),
        content: { kind: "signal", signalType: "event.matched", body: "injected update" },
      });
      await c.engineStore.settleUnclaimed(c.watch.childSessionId, c.childThread.id, "merged-signal", { outcome: "merged" });
      await c.watcher.observeTurn(c.watch.childSessionId, "merged-signal");
      await c.watcher.rearm();
      await childDelivery?.sweep();
      expect(await c.engineStore.listUnsettledSubmissions(c.watch.parentSessionId)).toHaveLength(1);
    });

    it("reclaims after background work ends without a new turn when warm retention is off", async () => {
      const c = await armedChild("deferred-reclaim", { retentionMs: 0 });
      await c.engineStore.createLease({ id: "ls_hold", sessionId: c.watch.childSessionId,
        ownerKind: "hold", reason: "person in terminal", deadlineAt: Date.now() + 60_000, createdAt: Date.now() });
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.watcher.sweepRetention(Date.now() + 1);
      expect(api!.providers.engineHost.liveSession(c.watch.childSessionId)).not.toBeNull();
      await c.engineStore.releaseLease("ls_hold", "cancelled", Date.now());
      await c.watcher.sweepRetention(Date.now() + 1);
      expect(api!.providers.engineHost.liveSession(c.watch.childSessionId)).toBeNull();
    });

    it.each(["archived", "deleted"] as const)("ends the subscription when the child is %s", async (status) => {
      const c = await armedChild(`lifetime-${status}`);
      await c.watcher.ensureSubscription(c.watch);
      await api!.providers.db.update(agentSessions).set({ status }).where(eq(agentSessions.id, c.watch.childSessionId));
      await c.watcher.rearm();
      c.watcher.arm(c.watch);
      await waitFor(async () => (await c.engineStore.getWakeup(`wk_child_events:${c.watch.childSessionId}`))?.status === "cancelled");
      expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
    });

    it.each([
      { outcome: "superseded", via: "observer" }, { outcome: "merged", via: "observer" },
      { outcome: "superseded", via: "watcher" }, { outcome: "merged", via: "watcher" },
    ] as const)("resolves a claimed $outcome signal through the $via so the subscription closes without reboot", async ({ outcome, via }) => {
      const c = await armedChild(`resolved-${outcome}`);
      const store = c.engineStore;
      await store.createLease({ id: "ls_background", sessionId: c.child.id, ownerKind: "hold", reason: "terminal open",
        deadlineAt: Date.now() + 60_000, createdAt: Date.now() });
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const id = "superseded-signal";
      await store.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, ""),
        content: { kind: "signal", signalType: "event.matched", body: "CI completed" } });
      expect((await store.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id,
        attemptId: "old-attempt", ownerId: "test" }))?.childResultDelivery).toBe("pending");
      await store.admitSubmission(c.child.id, c.childThread.id, queuedItem("steer", c.childThread.id, "new direction"), { steer: true });
      const fence = { itemId: id, attemptId: "old-attempt" };
      await store.reserveSettlement(c.child.id, c.childThread.id, id, { outcome }, fence);
      await store.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      if (via === "observer") await c.watcher.observeTurn(c.child.id, id);
      else c.watcher.arm({ ...c.watch, resultItemId: id });
      await vi.waitFor(async () => expect((await store.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("denied"));
      await store.settleUnclaimed(c.child.id, c.childThread.id, "steer", { outcome: "aborted" });
      await store.releaseLease("ls_background", "cancelled", Date.now());
      const waiter = await store.getWakeup(`wk_child_events:${c.child.id}`);
      if (!waiter) throw new Error("Missing child subscription");
      await c.watcher.closeSubscription(waiter);
      expect((await store.getWakeup(waiter.id))?.status).toBe("done");
      expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
    });

    it.each(["archived", "deleted", "missing-engine"] as const)("denies unpublished pending results of a %s child during recovery without rebuilding it", async state => {
      const c = await armedChild(`unavailable-${state}`);
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      const id = "unpublished";
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem(id, c.childThread.id, ""),
        content: { kind: "signal", signalType: "event.matched", body: "CI completed" } });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id, itemId: id, attemptId: "attempt", ownerId: "test" });
      const fence = { itemId: id, attemptId: "attempt" };
      await c.engineStore.reserveSettlement(c.child.id, c.childThread.id, id, { outcome: "completed" }, fence);
      await c.engineStore.finalizeSettlement(c.child.id, c.childThread.id, id, fence);
      const sessionFor = vi.spyOn(c.deps.engineHost, "sessionFor");
      const get = c.engineStore.getSession.bind(c.engineStore);
      const missing = state === "missing-engine" ? vi.spyOn(c.engineStore, "getSession").mockImplementation(session => session === c.child.id ? Promise.resolve(null) : get(session)) : undefined;
      if (state !== "missing-engine") await api!.providers.db.update(agentSessions).set({ status: state }).where(eq(agentSessions.id, c.child.id));
      try {
        const reboot = testChildWatcher(c.deps);
        await reboot.rearm();
        await reboot.rearm();
        expect(sessionFor).not.toHaveBeenCalled();
        expect((await c.engineStore.getQueueItem(c.child.id, id))?.childResultDelivery).toBe("denied");
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("cancelled");
        expect(await api!.providers.db.select().from(childEventOutbox)).toHaveLength(0);
        expect(await c.engineStore.listUnsettledSubmissions(c.parent.id)).toHaveLength(1);
      } finally { missing?.mockRestore(); sessionFor.mockRestore(); }
    });

    it("denies pending child results when the deletion route completes", async () => {
      const c = await armedChild("delete-pending");
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.engineStore.admitSubmission(c.child.id, c.childThread.id, { ...queuedItem("pending-delete", c.childThread.id, ""),
        content: { kind: "signal", signalType: "event.matched", body: "CI completed" } });
      await c.engineStore.claimSubmission({ sessionId: c.child.id, threadId: c.childThread.id,
        itemId: "pending-delete", attemptId: "attempt", ownerId: "test" });
      // Keep the engine rows to assert deletion's disposition, separately from resource teardown.
      const destroy = vi.spyOn(c.deps.engineHost, "destroy").mockResolvedValue(undefined);
      try {
        const response = await fetch(`${api!.baseUrl}/api/sessions/${c.child.id}`, { method: "DELETE" });
        expect(response.status).toBe(200);
        expect((await c.engineStore.getQueueItem(c.child.id, "pending-delete"))?.childResultDelivery).toBe("denied");
        expect((await c.engineStore.getWakeup(`wk_child_events:${c.child.id}`))?.status).toBe("cancelled");
        expect((await api!.providers.db.select().from(agentSessions).where(eq(agentSessions.id, c.child.id)))[0]?.status).toBe("deleted");
      } finally { destroy.mockRestore(); }
    });

    it("keeps an explicit cancellation across child turns and restart recovery", async () => {
      const c = await armedChild("cancel-subscription");
      await c.watcher.ensureSubscription(c.watch);
      const seam = buildWakeupsSeam({ engineStore: c.engineStore, limits: resolveWakeupLimits(process.env) }, c.watch.parentSessionId, () => undefined);
      const listing = await seam.list(c.watch.parentThreadId);
      expect(listing.wakeups.map((w) => w.id)).toContain(`wk_child_events:${c.watch.childSessionId}`);
      expect(await seam.cancel(`wk_child_events:${c.watch.childSessionId}`)).toEqual({ kind: "wakeup" });
      c.watcher.arm(c.watch);
      await waitFor(c.settled);
      await c.watcher.rearm();
      await childDelivery?.sweep();
      expect(await c.settledSignal()).toBeUndefined();
      expect((await c.engineStore.getWakeup(`wk_child_events:${c.watch.childSessionId}`))?.status).toBe("cancelled");
      expect(await c.engineStore.getSession(c.watch.childSessionId)).not.toBeNull();
    });
  });

  it.each(["failed", "aborted"] as const)(
    "includes a continuation checkpoint when a compacted child is %s",
    async (outcome) => {
      api = await bootTestApi();
      const deps = childrenDeps(api);
      const watcher = testChildWatcher(deps);
      const { engineHost, engineStore, db } = api.providers;

      const parent = await engineHost.sessionFor("parent-checkpoint", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp",
      });
      const parentThread = parent.thread("web:default");
      await parent.pause();
      const child = await engineHost.childSessionFor("child-checkpoint", {
        parentSessionId: "parent-checkpoint",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        orgId: "local-org",
        owner: { type: "user", id: "local-user" },
        workspace: "/tmp",
      });
      const childThread = child.thread("web:default");
      const itemId = `qi-checkpoint-${outcome}`;
      await engineStore.admitSubmission(
        "child-checkpoint",
        childThread.id,
        queuedItem(itemId, childThread.id, "implement"),
      );
      await childThread.appendEntry({
        id: "compaction-checkpoint",
        sessionId: "child-checkpoint",
        threadId: childThread.id,
        parentId: null,
        type: "compaction",
        summary: "## Continuation Checkpoint\n- Branch: fix/child\n- Next Action: rerun tests",
        coveredEntryIds: [],
        tokenCountBefore: 10,
        tokenCountAfter: 5,
        createdAt: Date.now(),
      });
      await engineStore.settleUnclaimed("child-checkpoint", childThread.id, itemId, {
        outcome,
        error: "continuation transport failed",
      });
      await db.insert(agentSessions).values({
        id: "child-checkpoint",
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp",
        status: "active",
        ownerType: "user",
        ownerId: "local-user",
        profile: "headless",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const watch = {
        childSessionId: "child-checkpoint",
        queueItemId: itemId,
        parentSessionId: "parent-checkpoint",
        parentThreadId: parentThread.id,
        actorUserId: "local-user",
        orgId: "local-org",
      };
      await db.insert(childWatches).values({
        ...watch,
        settled: false,
        createdAt: Date.now(),
      });

      watcher.arm(watch);
      await waitFor(async () => {
        const rows = await db
          .select()
          .from(childWatches)
          .where(eq(childWatches.childSessionId, "child-checkpoint"))
          .limit(1);
        return rows[0]?.settled === true;
      });

      const signals = await engineStore.listUnsettledSubmissions("parent-checkpoint");
      const content = signals[0]?.content;
      expect(content).toMatchObject({
        kind: "signal",
        signalType: "child.settled",
        attributes: {
          continuation_checkpoint_entry_id: "compaction-checkpoint",
          outcome,
        },
      });
      if (typeof content !== "object" || content === null || !("signalType" in content)) {
        throw new Error("expected child.settled signal");
      }
      expect(content.body).toContain("continuation transport failed");
      expect(content.body).toContain("Branch: fix/child");
      expect(content.body).toContain("Next Action: rerun tests");
    },
  );

  it.each([undefined, "auto", "manual"] satisfies ChannelOrigin["reply"][])("child.settled preserves reply policy %s across a rearm", async (reply) => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const parent = await engineHost.sessionFor("parent-o", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor("child-o", {
      parentSessionId: "parent-o",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");

    const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1.2", ...(reply !== undefined ? { reply } : {}) };
    const itemId = "qi-origin-settled-1";
    await engineStore.admitSubmission("child-o", childThread.id, { ...queuedItem(itemId, childThread.id, "work"),
      metadata: parentDelegationMetadata(parent.id, parentThread.id, origin) });
    await engineStore.settleUnclaimed("child-o", childThread.id, itemId, { outcome: "completed" });

    // The row a spawn from a Slack-addressed turn writes: origin captured at
    // spawn time, durable so the boot rearm() path inherits it too.
    await db.insert(childWatches).values({
      childSessionId: "child-o",
      queueItemId: itemId,
      parentSessionId: "parent-o",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      settled: false,
      createdAt: Date.now(),
      originJson: JSON.stringify(origin), replyRoute: "origin",
    });

    await db.insert(agentSessions).values({
      id: "child-o", userId: "local-user", orgId: "local-org", workspace: "/tmp", status: "active",
      ownerType: "user", ownerId: "local-user", createdAt: Date.now(), updatedAt: Date.now(),
    });

    // rearm() reads the row back — the restart path must not lose the origin.
    await watcher.rearm();

    await waitFor(async () => {
      const rows = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-o")).limit(1);
      return rows[0]?.settled === true;
    });

    const unsettled = await engineStore.listUnsettledSubmissions("parent-o");
    const settledSignals = unsettled.filter(
      (i) =>
        typeof i.content === "object" &&
        i.content !== null &&
        "kind" in i.content &&
        i.content.kind === "signal" &&
        (i.content as SignalContent).signalType === "child.settled",
    );
    expect(settledSignals).toHaveLength(1);
    const content = settledSignals[0]?.content;
    if (typeof content !== "object" || content === null || !("kind" in content) || content.kind !== "signal") {
      throw new Error("Expected a child settlement signal");
    }
    expect(content.origin).toEqual(origin);
    const deliveries = await db.select().from(childReplyDeliveries);
    expect(deliveries).toHaveLength(reply === "manual" ? 0 : 1);
    if (reply !== "manual") {
      expect(deliveries[0]?.queueItemId).toBe(settledSignals[0]?.id);
      // Simulate death after admission, before saving its receipt and settling the watch.
      await db.update(childReplyDeliveries).set({ queueItemId: null });
      await db.update(childWatches).set({ settled: false }).where(eq(childWatches.childSessionId, "child-o"));
      await testChildWatcher(deps).rearm();
      await waitFor(async () => {
        const [row] = await db.select().from(childReplyDeliveries);
        return row?.queueItemId === settledSignals[0]?.id;
      });
      expect(await engineStore.listUnsettledSubmissions("parent-o")).toHaveLength(1);
    }
  });

  it("leaves an un-diagnosable (retryable) failure UNSETTLED after exhausting in-process retries, relying on rearm() as the backstop", async () => {
    api = await bootTestApi();
    // Small budget so the test doesn't wait on the 30s production default.
    const deps = childrenDeps(api, { retryDelayMs: 15, maxRetryAttempts: 2 });
    const watcher = testChildWatcher(deps);
    const { db } = api.providers;

    // Keep the durable child present. An unknown rebuild failure is retryable;
    // a missing engine session is now an explicit cancellation condition.
    await api.providers.engineHost.childSessionFor("child-ghost", {
      parentSessionId: "parent-ghost", parentThreadId: "th-ghost", actorUserId: "local-user",
      orgId: "local-org", owner: { type: "user", id: "local-user" }, workspace: "/tmp",
    });
    const rebuild = vi.spyOn(api.providers.engineHost, "sessionFor").mockRejectedValue(new Error("temporary rebuild failure"));
    const watch = {
      childSessionId: "child-ghost",
      queueItemId: "qi-ghost",
      parentSessionId: "parent-ghost",
      parentThreadId: "th-ghost",
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now() });

    try {
      watcher.arm(watch);
      await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
    } finally { rebuild.mockRestore(); }

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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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

  it("fails the automatic reply intent when the parent can never receive the settlement", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const child = await engineHost.childSessionFor("child-denied-reply", {
      parentSessionId: "parent-does-not-exist",
      parentThreadId: "th-does-not-exist",
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" };
    const itemId = "qi-denied-reply";
    await engineStore.admitSubmission("child-denied-reply", childThread.id, { ...queuedItem(itemId, childThread.id, "work"),
      metadata: parentDelegationMetadata("parent-does-not-exist", "th-does-not-exist", origin) });
    await engineStore.settleUnclaimed("child-denied-reply", childThread.id, itemId, { outcome: "completed" });

    const watch = {
      childSessionId: "child-denied-reply",
      queueItemId: itemId,
      parentSessionId: "parent-does-not-exist",
      parentThreadId: "th-does-not-exist",
      actorUserId: "local-user",
      orgId: "local-org",
    };
    await db.insert(childWatches).values({ ...watch, settled: false, createdAt: Date.now(), originJson: JSON.stringify(origin), replyRoute: "origin" });

    watcher.arm({ ...watch, origin });
    await waitFor(async () => {
      const [row] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-denied-reply"));
      return row?.settled === true;
    });

    // The intent was written before admission. With no parent update to
    // post, it must end failed now, not wait out the admission window.
    const [intent] = await db.select().from(childReplyDeliveries);
    expect(intent?.id).toBe(`child-denied-reply:settled:child-denied-reply:${itemId}`);
    expect(intent?.queueItemId).toBeNull();
    expect(intent?.completedAt).toBeNull();
    expect(intent?.failedAt).not.toBeNull();
    expect(intent?.lastError).toContain("parent-does-not-exist");
  });

  it("tears down the child's sandbox and evicts its cached session on settle, keeping session data", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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

describe("childParkAction (fix wave 4, concurrency N1)", () => {
  it("leaves a provisioning sandbox alone, so a replace in flight keeps its sandbox", () => {
    expect(childParkAction("provisioning", true)).toBe("skip");
    expect(childParkAction("provisioning", false)).toBe("skip");
  });
  it("parks a retainable ready or suspended sandbox and destroys the rest", () => {
    expect(childParkAction("ready", true)).toBe("suspend");
    expect(childParkAction("suspended", true)).toBe("record_suspended");
    expect(childParkAction("ready", false)).toBe("destroy");
    expect(childParkAction("detached", true)).toBe("destroy");
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

  it("bounds a large continuation checkpoint and points to child_read", () => {
    const body = resultBody(
      { queueItemId: "q1", outcome: "failed", error: "failed" },
      childId,
      {
        id: "checkpoint-large",
        sessionId: childId,
        threadId: "thread-child",
        parentId: null,
        type: "compaction",
        summary: "c".repeat(CHILD_RESULT_MAX_CHARS * 10),
        coveredEntryIds: [],
        tokenCountBefore: 10,
        tokenCountAfter: 5,
        createdAt: Date.now(),
      },
    );
    expect(body.length).toBeLessThanOrEqual(CHILD_RESULT_MAX_CHARS + 400);
    expect(body).toContain("checkpoint-large");
    expect(body).toContain("Checkpoint truncated");
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
  it("reads a child of a private team thread only from that thread", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const reader = buildChildReader(childrenDeps(api));
    await db.execute(sql`INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, parent_session_id, parent_thread_id, created_at, updated_at) VALUES
      ('team-runtime', 'team', 'team-1', 'local-user', 'local-org', '/', 'interactive', 'running', NULL, NULL, 1, 1),
      ('private-child', 'team', 'team-1', 'local-user', 'local-org', '/', 'child', 'running', 'team-runtime', 'thr-helper', 1, 1),
      ('shared-child', 'team', 'team-1', 'local-user', 'local-org', '/', 'child', 'running', 'team-runtime', 'thr-shared', 1, 1)`);
    await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at) VALUES
      ('thr-helper', 'team-runtime', 'app-assistant:local-user', 'idle', 'steer', 1, 1),
      ('thr-shared', 'team-runtime', 'web:default', 'idle', 'steer', 1, 1),
      ('thr-slack', 'team-runtime', 'slack:CPUB:1.1', 'idle', 'steer', 1, 1)`);
    // A team rule thread whose deliveries came from private channel CPRIVA.
    await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, metadata, created_at, updated_at) VALUES
      ('thr-rule', 'team-runtime', 'sub:rule-1', 'idle', 'steer', ${JSON.stringify({ slackChannels: ["CPRIVA"] })}, 1, 1)`);
    for (const [child, parentThreadId] of [["private-child", "thr-helper"], ["shared-child", "thr-shared"]] as const) {
      await db.insert(agentSessions).values({ id: child, userId: "local-user", orgId: "local-org", workspace: "/", ownerType: "team", ownerId: "team-1", createdAt: 1, updatedAt: 1 });
      await db.insert(childWatches).values({ childSessionId: child, queueItemId: `q-${child}`, parentSessionId: "team-runtime", parentThreadId,
        actorUserId: "local-user", orgId: "local-org", createdAt: 1 });
    }
    // The helper thread that started it reads it; a shared thread does not.
    expect(await reader({ childSessionId: "private-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-helper" })).toEqual([]);
    expect(await reader({ childSessionId: "private-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-shared" })).toBeNull();
    // A child of a shared thread is readable from any of the team's own threads.
    expect(await reader({ childSessionId: "shared-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-helper" })).toEqual([]);
    // A Slack conversation has readers outside the team, so it reaches only
    // what `thread_read` lets it read: not a team web thread's child.
    expect(await reader({ childSessionId: "shared-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-slack" })).toBeNull();
    // A rule thread holding private channel content has readers outside the
    // team too, so it cannot read or steer a team web thread's child.
    expect(await reader({ childSessionId: "shared-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-rule" })).toBeNull();
    const ruleSender = buildChildSender(childrenDeps(api), testChildWatcher(childrenDeps(api)));
    expect(await ruleSender({ childSessionId: "shared-child", message: "redirect" },
      { parentSessionId: "team-runtime", parentThreadId: "thr-rule", actorUserId: "local-user" })).toBeNull();
    // child_status and child_send apply the same rule.
    const status = buildChildStatusReader(childrenDeps(api));
    expect(await status({ childSessionId: "private-child" }, { parentSessionId: "team-runtime", readerThreadId: "thr-shared" })).toBeNull();
    const deps = childrenDeps(api);
    const sender = buildChildSender(deps, testChildWatcher(deps));
    expect(await sender({ childSessionId: "private-child", message: "redirect" },
      { parentSessionId: "team-runtime", parentThreadId: "thr-shared", actorUserId: "local-user" })).toBeNull();
  });

  it("returns the child's messages to the parent that spawned it", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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

  it("reports running work even when the notification flag is settled", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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
    expect(status?.settled).toBe(false);
  });

  it("derives settled=true from the child's durable turn state when the watch flag was lost to a restart", async () => {
    // Regression (prod incident): a deploy dropped the in-memory `child.settled`
    // signal, so `child_watches.settled` stayed false even though the child's
    // turn had durably settled. `sec_cell_complete` then 409'd "not settled"
    // forever and the runner re-dispatched a finished child in a loop. The
    // reader must self-heal by reading the child's own durable turn state.
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    const statusReader = buildChildStatusReader(deps);

    await api.providers.engineHost.sessionFor("parent-status-restart", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const spawned = await spawner(
      { prompt: "verify the phase" },
      {
        parentSessionId: "parent-status-restart",
        parentThreadId: "web:default",
        actorUserId: "local-user",
        owner: { type: "user", id: "local-user" },
      },
    );

    // The child's turn settles durably (its queue item → settled), but the
    // child.settled signal never lands, so the watch row stays unsettled —
    // exactly the stranded state a mid-flight restart leaves.
    await api.providers.db.execute(
      sql`UPDATE engine_queue_items SET status = 'settled', updated_at = ${Date.now() - 1000} WHERE session_id = ${spawned.childSessionId}`,
    );
    const [watch] = await api.providers.db
      .select({ settled: childWatches.settled })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, spawned.childSessionId))
      .limit(1);
    expect(watch.settled).toBe(false);

    const status = await statusReader(
      { childSessionId: spawned.childSessionId },
      { parentSessionId: "parent-status-restart" },
    );
    // Derived from the durable turn state, not the stale watch flag.
    expect(status?.settled).toBe(true);
  });

  it("returns null for a child the caller did not spawn, and for a missing id", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
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
  async function seedChild(a: TestApi, opts: { childId: string; parentId: string; settled: boolean; queueItemId: string; teamId?: string; credentialOwnerMode?: "owner" | "actor"; origin?: ChannelOrigin }) {
    const { engineHost, engineStore, db } = a.providers;
    const parent = await engineHost.sessionFor(opts.parentId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      ...(opts.teamId ? { ownerType: "team", ownerTeamId: opts.teamId } : {}),
    });
    const parentThread = parent.thread("web:default");
    await parent.pause();

    const child = await engineHost.childSessionFor(opts.childId, {
      parentSessionId: opts.parentId,
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: opts.teamId ? { type: "team", id: opts.teamId } : { type: "user", id: "local-user" },
      credentialOwnerMode: opts.credentialOwnerMode,
      workspace: "/tmp",
    });
    const childThread = child.thread("web:default");
    await child.pause();

    // Stamped as the real spawner stamps the delegated work.
    await engineStore.admitSubmission(opts.childId, childThread.id, {
      ...queuedItem(opts.queueItemId, childThread.id, "original task"),
      metadata: parentDelegationMetadata(opts.parentId, parentThread.id, opts.origin),
    });
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
      ownerType: opts.teamId ? "team" : "user",
      ownerId: opts.teamId ?? "local-user",
      credentialOwnerMode: opts.credentialOwnerMode,
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

  it.each(["owner", "actor"] as const)("persists the steering teammate as actor in %s credential mode", async (credentialOwnerMode) => {
    api = await bootTestApi();
    const { db, engineStore, engineCredentials } = api.providers;
    await db.insert(teams).values({ id: "steer-team", orgId: "local-org", name: "Steering", createdAt: 1 });
    await db.insert(teamMembers).values([
      { teamId: "steer-team", userId: "local-user", role: "member" },
      { teamId: "steer-team", userId: "test-member", role: "member" },
    ]);
    await engineCredentials.save({ type: "user", id: "local-user" }, "linear", { type: "api_key", apiKey: "spawner-key" });
    await shareCredential(db, { teamId: "steer-team", userId: "local-user", service: "linear", createdAt: 1 });
    const { child, parentThread } = await seedChild(api, {
      childId: "actor-child", parentId: "actor-parent", settled: false, queueItemId: "original-actor",
      teamId: "steer-team", credentialOwnerMode,
    });
    await parentThread.setToolFocus({ actions: ["workflows.get_run"] });
    const deps = childrenDeps(api);
    const receipt = await buildChildSender(deps, testChildWatcher(deps))(
      { childSessionId: child.id, message: "Check Linear" },
      { parentSessionId: "actor-parent", parentThreadId: parentThread.id, actorUserId: "test-member", toolScope: { actions: ["linear.*"] } },
    );
    const submission = (await engineStore.listUnsettledSubmissions(child.id)).find(item => item.id === receipt?.queueItemId);
    expect(submission?.author).toEqual({ id: "test-member", name: "Valet" });
    // Steering keeps the sender's ceiling and drops the parent's thread focus.
    expect(submission?.metadata?.toolScope).toEqual({ actions: ["linear.*"] });
    expect(await child.credentialProvider({ actorId: submission?.author?.id }).get("linear")).toBeNull();
  });

  it("answers null for a session that is not this parent's child", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const sender = buildChildSender(deps, testChildWatcher(deps));
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
    const sender = buildChildSender(deps, testChildWatcher(deps));
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
    const sender = buildChildSender(deps, testChildWatcher(deps));
    expect(
      await sender(
        { childSessionId: "child-del", message: "hello" },
        { parentSessionId: "parent-del", parentThreadId: "th-del", actorUserId: "local-user" },
      ),
    ).toBeNull();
  });

  it("steers a running child by default: supersedes its work, re-points the watch, and reports the new result", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
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
      { childSessionId: "child-steer", message: "stop — fix the chart instead" },
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
    await appendTerminalResult(engineStore, "child-steer", childThread.id, res?.queueItemId ?? "");
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

  it("queues behind a running child with queue true: the original submission stays unsettled", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread } = await seedChild(api, {
      childId: "child-fu",
      parentId: "parent-fu",
      settled: false,
      queueItemId: "qi-fu-orig",
    });

    const sender = buildChildSender(deps, watcher);
    const res = await sender(
      { childSessionId: "child-fu", message: "when you finish, also update the docs", queue: true },
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

  it.each([undefined, "auto", "manual"] satisfies ChannelOrigin["reply"][])("re-opens a settled child from another thread with a manual reply (stored policy %s)", async (reply) => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread, childThread } = await seedChild(api, {
      childId: "child-again",
      parentId: "parent-again",
      settled: true,
      queueItemId: "qi-done",
    });

    const origin: ChannelOrigin = { channelType: "slack", threadKey: "slack:C1:1.2", ...(reply !== undefined ? { reply } : {}) };
    // The user dismissed the settled child; a re-open must resurface it.
    await db
      .update(childWatches)
      .set({ dismissedAt: Date.now(), originJson: JSON.stringify(origin), replyRoute: "origin" })
      .where(eq(childWatches.childSessionId, "child-again"));

    const sender = buildChildSender(deps, watcher);
    // Send from a DIFFERENT thread than the spawn origin: the durable edge
    // (and the settlement signal) must stay with the spawning thread, but
    // the channel thread no longer gets an automatic post.
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
    const content = signals[0]?.content;
    if (typeof content !== "object" || content === null || !("kind" in content) || content.kind !== "signal") {
      throw new Error("Expected a child settlement signal");
    }
    expect(content.origin).toEqual({ ...origin, reply: "manual" });
  });

  it.each([true, false])("follows a successor across rearm with human takeover %s", async (humanTakeover) => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineHost, engineStore, db } = api.providers;

    const { parentThread, childThread } = await seedChild(api, {
      childId: "child-heal",
      parentId: "parent-heal",
      settled: false,
      queueItemId: "qi-heal-orig",
    });
    await db.update(childWatches).set({ originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }), replyRoute: "origin" })
      .where(eq(childWatches.childSessionId, "child-heal"));
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
    // A person's steer, or the parent's own child_send with the real sender's options.
    const receipt = await child!.prompt("changed my mind — do it differently", humanTakeover
      ? { author: { id: "local-user" }, queueMode: "steer" }
      : childSendPromptOptions({ parentSessionId: "parent-heal", parentThreadId: parentThread.id, actorUserId: "local-user", origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" } }, false));

    // The stale watcher wakes on the superseded original and must move the
    // watch to the successor instead of going silent (or reporting it).
    await waitFor(async () => {
      const r = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-heal")).limit(1);
      return r[0]?.queueItemId === receipt.queueItemId;
    });
    expect(settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-heal"))).toHaveLength(0);

    await testChildWatcher(deps).rearm();

    // The successor settles: exactly one signal, for the successor.
    await appendTerminalResult(engineStore, "child-heal", childThread.id, receipt.queueItemId);
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
    expect(content.origin).toEqual(humanTakeover ? undefined : { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" });
    const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-heal"));
    // The channel provenance never changes. Only the reply route records the takeover.
    expect(watch?.originJson).toBe(JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }));
    expect(watch?.replyRoute).toBe(humanTakeover ? "none" : "origin");
    expect(await db.select().from(childReplyDeliveries)).toHaveLength(humanTakeover ? 0 : 1);
    // A rebuilt child is still a channel-started child with a shared transcript.
    engineHost.evictCache("child-heal");
    const rebuilt = await engineHost.sessionFor("child-heal", { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
    expect(rebuilt.options.sharedTranscript).toBe(true);
  });

  it.each([
    { route: "no channel origin", origin: null, replyRoute: null },
    { route: "a manual origin", origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "manual" }, replyRoute: null },
    { route: "a taken-over automatic origin", origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }, replyRoute: "none" },
    { route: "a pending automatic reply", origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }, replyRoute: "origin" },
    { route: "a legacy automatic origin", origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }, replyRoute: null },
  ] satisfies Array<{ route: string; origin: ChannelOrigin | null; replyRoute: string | null }>)(
    "child_status reports turn state without acknowledging the event with $route",
    async ({ origin, replyRoute }) => {
      api = await bootTestApi();
      const deps = childrenDeps(api);
      const { db } = api.providers;
      await seedChild(api, { childId: "child-repair", parentId: "parent-repair", settled: true, queueItemId: "qi-repair" });
      // The watcher gave up in-process, so the row stayed unsettled.
      await db.update(childWatches).set({ settled: false, originJson: origin ? JSON.stringify(origin) : null, replyRoute })
        .where(eq(childWatches.childSessionId, "child-repair"));

      expect((await resolveChildSettlement(deps, "child-repair", "parent-repair"))?.settled).toBe(true);
      const [watch] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-repair"));
      // Only event delivery acknowledges the parent notification.
      expect(watch?.settled).toBe(false);
    },
  );

  it("ends reply intents for moved watches on rearm, using a landed admission when there is one", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const { engineStore, db } = api.providers;
    const { parentThread } = await seedChild(api, { childId: "child-orphan", parentId: "parent-orphan", settled: false, queueItemId: "qi-later" });
    const intent = (childItemId: string) => ({
      id: `child-orphan:settled:child-orphan:${childItemId}`, orgId: "local-org", sessionId: "parent-orphan",
      threadId: parentThread.id, childSessionId: "child-orphan", childQueueItemId: childItemId, nextAttemptAt: 0, createdAt: 0,
    });
    // Two earlier child submissions wrote intents, then the process stopped
    // and the watch moved to later work. One admission had landed.
    await db.insert(childReplyDeliveries).values([intent("qi-lost"), intent("qi-landed")]);
    const now = Date.now();
    await engineStore.admitSubmission("parent-orphan", parentThread.id, {
      id: "qi-parent-landed", threadId: parentThread.id, dispatchId: intent("qi-landed").id, content: "child settled",
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 3_600_000, createdAt: now, updatedAt: now,
    });

    await testChildWatcher(deps).rearm();
    const rows = await db.select().from(childReplyDeliveries);
    const byItem = new Map(rows.map((row) => [row.childQueueItemId, row]));
    expect(byItem.get("qi-landed")).toMatchObject({ queueItemId: "qi-parent-landed", completedAt: null });
    expect(byItem.get("qi-lost")).toMatchObject({ queueItemId: null, failedAt: null });
    expect(byItem.get("qi-lost")?.completedAt).not.toBeNull();
  });

  it("re-opens a failed reply intent when it admits the parent update", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
    const { engineStore, db } = api.providers;

    const { parentThread, childThread } = await seedChild(api, {
      childId: "child-revive", parentId: "parent-revive", settled: false, queueItemId: "qi-revive",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" },
    });
    await db.update(childWatches).set({ originJson: JSON.stringify({ channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" }), replyRoute: "origin" })
      .where(eq(childWatches.childSessionId, "child-revive"));
    // An earlier attempt wrote the intent, and the dispatcher failed it
    // before any parent update was admitted.
    const replyId = "child-revive:settled:child-revive:qi-revive";
    await db.insert(childReplyDeliveries).values({
      id: replyId, orgId: "local-org", sessionId: "parent-revive", threadId: parentThread.id,
      childSessionId: "child-revive", childQueueItemId: "qi-revive",
      nextAttemptAt: 0, createdAt: 0, attempts: 10, failedAt: 1, lastError: "earlier failure",
    });
    await db.insert(eventDropLog).values({
      id: `child-reply:${replyId}`, orgId: "local-org", reason: "child_reply_failed", detail: "earlier failure", createdAt: 1,
    });

    await engineStore.settleUnclaimed("child-revive", childThread.id, "qi-revive", { outcome: "completed" });
    watcher.arm({
      childSessionId: "child-revive", queueItemId: "qi-revive", parentSessionId: "parent-revive",
      parentThreadId: parentThread.id, actorUserId: "local-user", orgId: "local-org",
    });
    await waitFor(async () => {
      const [row] = await db.select().from(childWatches).where(eq(childWatches.childSessionId, "child-revive"));
      return row?.settled === true;
    });

    // The parent update now exists, so the reply must be delivered.
    const [signal] = settledSignalsOf(await engineStore.listUnsettledSubmissions("parent-revive"));
    const [intent] = await db.select().from(childReplyDeliveries).where(eq(childReplyDeliveries.id, replyId));
    expect(intent).toMatchObject({ queueItemId: signal?.id, failedAt: null, attempts: 0, lastError: null, completedAt: null });
    expect(await db.select().from(eventDropLog).where(eq(eventDropLog.id, `child-reply:${replyId}`))).toHaveLength(0);
  });

  it("re-opening a settled child pays the child cap: the 11th active child is rejected", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api);
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
        { childSessionId: "child-race", message: "first follow-up", queue: true },
        { parentSessionId: "parent-race", parentThreadId: parentThread.id, actorUserId: "local-user" },
      ),
      sender(
        { childSessionId: "child-race", message: "second follow-up", queue: true },
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
    onCreate?: () => Promise<void>;
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
      await this.onCreate?.();
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

  it("engine reclaim fence aborts when a running claim wins before destruction", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    let modelCalls = 0;
    faux.setResponses([async () => { modelCalls++; await held; return fauxAssistantMessage("done"); }]);
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: RETENTION_MS }));
    const { child, childThread, watch } = await seedParkableChild(api, "active-fence", "parent-active-fence");
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
    const destroy = vi.spyOn(child.attachment, "destroy");
    // The outer retention checks see an idle session. A claim wins inside cleanup before beginReclaim.
    const host = api.providers.engineHost;
    const cleanup = host.withSandboxCleanup.bind(host);
    let itemId!: string;
    const race = vi.spyOn(host, "withSandboxCleanup").mockImplementationOnce((id, work) => cleanup(id, async () => {
      itemId = (await childThread.submitPrompt("hold the running turn", {})).queueItemId;
      await vi.waitFor(() => expect(modelCalls).toBe(1));
      return work();
    }));
    try {
      await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
      expect(destroy).not.toHaveBeenCalled();
      expect(childThread.hasActiveRun).toBe(true);
      expect(child.isReclaiming).toBe(false);
      host.evictCache(child.id);
      expect(host.liveSession(child.id)).toBe(child);
      expect(await host.sessionFor(child.id, { userId: "local-user", orgId: "local-org", workspace: "/tmp" })).toBe(child);
      expect((await api.providers.engineStore.getQueueItem(child.id, itemId))?.attemptCount).toBe(1);
      finish();
      expect((await childThread.awaitResult(itemId)).outcome).toBe("completed");
      expect(modelCalls).toBe(1);
    } finally { finish(); race.mockRestore(); destroy.mockRestore(); faux.unregister(); vi.unstubAllEnvs(); }
  });

  it.each(["fast", "held-model"] as const)("engine reclaim repro: unpaused %s admission runs once on fresh compute", async variant => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    let modelRelease!: () => void;
    const modelGate = new Promise<void>(resolve => { modelRelease = resolve; });
    let modelCalls = 0;
    faux.setResponses([
      async () => { modelCalls++; if (variant === "held-model") await modelGate;
        return fauxAssistantMessage([fauxToolCall("write", { path: "/tmp/unpaused-marker", content: "exactly once" }, { id: "unpaused-write" })], { stopReason: "toolUse" }); },
      () => { modelCalls++; return fauxAssistantMessage("done"); },
      () => { modelCalls++; return fauxAssistantMessage("duplicate"); },
    ]);
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: 0 });
    const watcher = testChildWatcher(deps);
    const { child, childThread, watch } = await seedParkableChild(api, `unpaused-${variant}`, "parent-unpaused");
    const host = api.providers.engineHost;
    const resolved = await host.sessionFor(child.id, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
    let entered!: () => void;
    const destroying = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const destroy = child.attachment.destroy.bind(child.attachment);
    const blocked = vi.spyOn(child.attachment, "destroy").mockImplementation(async reason => { entered(); await held; return destroy(reason); });
    watcher.arm(watch);
    const reclaim = waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    let restoreResolution: (() => void) | undefined;
    try {
      await destroying;
      const resolving = vi.spyOn(host, "sessionFor").mockResolvedValueOnce(resolved);
      restoreResolution = () => resolving.mockRestore();
      const [row] = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, child.id));
      if (!row) throw new Error("child row missing");
      const sent = await submitSessionPrompt(api.providers, row, "write the marker", { author: { id: "local-user" } });
      if (!sent?.messageId) throw new Error("prompt not admitted");
      resolving.mockRestore(); restoreResolution = undefined;
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      const before = await api.providers.engineStore.getQueueItem(child.id, sent.messageId);
      release();
      await vi.waitFor(() => expect(child.attachment.state).toBe("released"));
      const recovered = await host.sessionFor(child.id, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
      if (variant === "held-model") {
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        expect(childThread.hasActiveRun).toBe(false);
        expect((await api.providers.engineStore.getQueueItem(child.id, sent.messageId))?.attemptCount).toBe(1);
      }
      modelRelease();
      const thread = recovered.threadById(childThread.id);
      if (!thread) throw new Error("restored thread missing");
      await thread.awaitResult(sent.messageId);
      expect(before?.status).toBe("queued");
      expect((await api.providers.engineStore.getQueueItem(child.id, sent.messageId))?.attemptCount).toBe(1);
      expect(modelCalls).toBe(2);
      expect(await recovered.sandbox.readFile("/tmp/unpaused-marker")).toBe("exactly once");
    } finally { release(); modelRelease(); await reclaim; restoreResolution?.(); blocked.mockRestore(); faux.unregister(); vi.unstubAllEnvs(); }
  });

  it.each([
    ["retention", "web"], ["eager", "web"], ["retention", "signal"], ["eager", "signal"],
    ["retention", "cli"], ["eager", "cli"], ["retention", "child_send"], ["eager", "child_send"],
  ] as const)("review released-cache repro: %s reclaim preserves queued %s work on a usable session", async (mode, caller) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    let modelCalls = 0;
    faux.setResponses([
      () => { modelCalls++; return fauxAssistantMessage([fauxToolCall("write", { path: "/tmp/reclaimed-prompt.txt", content: "prompt ran" }, { id: "reclaimed-write" })], { stopReason: "toolUse" }); },
      () => { modelCalls++; return fauxAssistantMessage("recovered"); },
    ]);
    const provider = new HibernatingChildProvider();
    provider.hibernation = mode === "retention";
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: mode === "retention" ? RETENTION_MS : 0 });
    const watcher = testChildWatcher(deps);
    const { child, childThread, watch } = await seedParkableChild(api, `released-${mode}-${caller}`, "parent-released-cache");
    if (mode === "retention") {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
    }
    const host = api.providers.engineHost;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const resolved = await host.sessionFor(child.id, meta);
    const resolveSession = host.sessionFor.bind(host);
    let entered!: () => void;
    const destroying = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const destroy = child.attachment.destroy.bind(child.attachment);
    const blocked = vi.spyOn(child.attachment, "destroy").mockImplementation(async reason => { entered(); await held; return destroy(reason); });
    const reclaim = mode === "retention" ? watcher.sweepRetention(Date.now() + RETENTION_MS + 1)
      : (watcher.arm(watch), waitFor(async () => (await watchRow(api!, child.id))?.settled === true));
    let restoreResolution: (() => void) | undefined;
    try {
      await destroying;
      // The caller resolved before reclaim, but its admission resumes during provider destruction.
      const resolving = vi.spyOn(host, "sessionFor").mockImplementationOnce(async () => resolved);
      restoreResolution = () => resolving.mockRestore();
      const [row] = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, child.id));
      if (!row) throw new Error("the child app row is missing");
      const admission = caller === "web"
        ? submitSessionPrompt(api.providers, row, "write the recovery marker", { author: { id: "local-user" } })
        : caller === "signal" ? admitSignal(deps, { from: { sessionId: watch.parentSessionId, owner: { type: "user", id: "local-user" } },
          to: child.id, threadKey: childThread.id, dispatchId: `released-${mode}`,
          content: { kind: "signal", signalType: "test.recovery", body: "write the recovery marker" } })
        : caller === "cli" ? new InstanceClient({ url: api.baseUrl }).sendPrompt(child.id, { text: "write the recovery marker" })
        : buildChildSender(deps, watcher)({ childSessionId: child.id, message: "write the recovery marker", queue: true }, {
          parentSessionId: watch.parentSessionId, parentThreadId: watch.parentThreadId, actorUserId: "local-user",
        });
      // Every thread is unpaused. Resolved references may admit, but no caller can start on the retiring attachment.
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      expect(childThread.hasActiveRun).toBe(false);
      expect(modelCalls).toBe(0);
      release();
      const receipt = await admission;
      const itemId = receipt && ("messageId" in receipt ? receipt.messageId : "queueItemId" in receipt ? receipt.queueItemId : undefined);
      if (!itemId) throw new Error("the prompt was not admitted");
      resolving.mockRestore();
      restoreResolution = undefined;
      await reclaim;
      await vi.waitFor(async () => expect((await api!.providers.engineStore.getQueueItem(child.id, itemId))?.status).toBe("settled"));
      const recovered = await resolveSession(child.id, meta);
      expect(recovered).not.toBe(resolved);
      await expect(recovered.attachment.ensureReady({ timeoutMs: 5000 })).resolves.toBeDefined();
      const thread = recovered.threadById(childThread.id);
      if (!thread) throw new Error("the admitted thread was lost during recovery");
      expect((await thread.awaitResult(itemId)).outcome).toBe("completed");
      expect(await recovered.sandbox.readFile("/tmp/reclaimed-prompt.txt")).toBe("prompt ran");
      expect(modelCalls).toBe(2);
      expect((await api.providers.engineStore.getQueueItem(child.id, itemId))?.attemptCount).toBe(1);
      expect(await host.sessionFor(child.id, meta)).toBe(recovered);
      await expect((await host.sessionFor(child.id, meta)).attachment.ensureReady({ timeoutMs: 1000 })).resolves.toBeDefined();
    } finally { release(); await reclaim; restoreResolution?.(); blocked.mockRestore(); faux.unregister(); vi.unstubAllEnvs(); }
  });

  it.each(["retention", "eager"] as const)("review destroy-window repro: %s reclaim admits a concurrent send on one rebuilt session", async mode => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = mode === "retention";
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: mode === "retention" ? RETENTION_MS : 0 });
    const watcher = testChildWatcher(deps);
    const { child, watch } = await seedParkableChild(api, `destroy-window-${mode}`, "parent-destroy-window");
    await child.pause();
    if (mode === "retention") {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
    }
    let entered!: () => void;
    const destroying = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const destroyRelease = new Promise<void>(resolve => { release = resolve; });
    const destroy = child.attachment.destroy.bind(child.attachment);
    const blocked = vi.spyOn(child.attachment, "destroy").mockImplementation(async reason => {
      entered();
      await destroyRelease;
      return destroy(reason);
    });
    const originalPrompt = vi.spyOn(child, "prompt");
    const create = vi.spyOn(provider, "create");
    const host = api.providers.engineHost;
    const resolveSession = host.sessionFor.bind(host);
    const resolutions: Session[] = [];
    const resolving = vi.spyOn(host, "sessionFor").mockImplementation(async (id, meta) => {
      const session = await resolveSession(id, meta);
      if (id === child.id) resolutions.push(session);
      return session;
    });
    const reclaim = mode === "retention" ? watcher.sweepRetention(Date.now() + RETENTION_MS + 1)
      : (watcher.arm(watch), waitFor(async () => {
        const row = await watchRow(api!, child.id);
        return row?.settled === true || row?.queueItemId !== watch.queueItemId;
      }));
    try {
      await destroying;
      resolutions.length = 0;
      const send = buildChildSender(deps, watcher)({ childSessionId: child.id, message: "revive during destroy" },
        { parentSessionId: watch.parentSessionId, parentThreadId: watch.parentThreadId, actorUserId: "local-user" });
      const waking = host.sessionFor(child.id, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
      // Give admission and direct session resolution their windows while destruction is held open.
      const waitWindow = () => new Promise<false>(resolve => setTimeout(() => resolve(false), 100));
      const [admittedBeforeRelease, wokeBeforeRelease] = await Promise.all([
        Promise.race([send.then(() => true), waitWindow()]),
        Promise.race([waking.then(() => true), waitWindow()]),
      ]);
      release();
      await reclaim;
      const sent = await send;
      if (!sent) throw new Error("the concurrent send was not admitted");
      const replacement = host.liveSession(child.id);
      expect(replacement).not.toBeNull();
      if (!replacement) throw new Error("the send was stranded without a cached session");
      expect(replacement).not.toBe(child);
      expect(await waking).toBe(replacement);
      expect(admittedBeforeRelease).toBe(false);
      expect(wokeBeforeRelease).toBe(false);
      expect(originalPrompt).not.toHaveBeenCalled();
      expect(child.attachment.state).toBe("released");
      await replacement.attachment.ensureReady({ timeoutMs: 5000 });
      expect(replacement.attachment.state).toBe("ready");
      expect((await replacement.sandbox.exec("echo revived")).stdout).toBe("revived\n");
      expect((await provider.status(replacement.attachment.sandboxId!)).state).toBe("ready");
      expect((await watchRow(api, child.id))?.queueItemId).toBe(sent.queueItemId);
      expect((await watchRow(api, child.id))?.settled).toBe(false);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      expect((await api.providers.engineStore.getQueueItem(child.id, sent.queueItemId))?.status).toBe("queued");
      // Another watcher resolution and a direct wake must reuse the admitting session.
      const resolvedBeforeWatcher = resolutions.length;
      watcher.arm({ ...watch, queueItemId: sent.queueItemId });
      await vi.waitFor(() => expect(resolutions.length).toBeGreaterThan(resolvedBeforeWatcher));
      expect(await host.sessionFor(child.id, { userId: "local-user", orgId: "local-org", workspace: "/tmp" })).toBe(replacement);
      expect(new Set(resolutions)).toEqual(new Set([replacement]));
      expect(create).toHaveBeenCalledTimes(1);
    } finally { release(); await reclaim; blocked.mockRestore(); originalPrompt.mockRestore(); create.mockRestore(); resolving.mockRestore(); }
  });

  it("review reclaim repro: status confirmation fences revival before replacement cleanup", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = testChildWatcher(deps);
    const { watch, child, childThread } = await seedParkableChild(api, "stale-reclaim", "parent-stale-reclaim");
    await child.pause();
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
    const oldId = provider.suspendCalls[0]!;
    let entered!: () => void;
    const statusEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const statusRelease = new Promise<void>(resolve => { release = resolve; });
    const status = api.providers.engineHost.sandboxStatus.bind(api.providers.engineHost);
    const blocked = vi.spyOn(api.providers.engineHost, "sandboxStatus").mockImplementation(async id => {
      if (id === oldId) { entered(); await statusRelease; }
      return status(id);
    });
    const sweep = watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    try {
      await statusEntered;
      const sending = buildChildSender(deps, watcher)({ childSessionId: child.id, message: "revive" },
        { parentSessionId: watch.parentSessionId, parentThreadId: watch.parentThreadId, actorUserId: "local-user" });
      let admittedBeforeRelease = false;
      await Promise.race([sending.then(() => { admittedBeforeRelease = true; }), new Promise<void>(resolve => setTimeout(resolve, 100))]);
      expect(admittedBeforeRelease).toBe(false);
      release();
      await sweep;
      const sent = await sending;
      if (!sent) throw new Error("the child send did not revive the child");
      const replacement = api.providers.engineHost.liveSession(child.id);
      if (!replacement) throw new Error("the replacement is not cached");
      await replacement.attachment.ensureReady({ timeoutMs: 5000 });
      const newId = replacement.attachment.sandboxId;
      expect(newId).not.toBe(oldId);
      await api.providers.db.insert(sandboxTokens).values({ id: "replacement-token", tokenHash: "replacement-hash", sessionId: child.id,
        userId: "local-user", orgId: "local-org", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      const data = await api.providers.engineStore.getSession(child.id);
      if (!data) throw new Error("the replacement session is missing");
      await api.providers.engineStore.saveSession({ ...data, sandboxId: newId });
      expect(api.providers.engineHost.liveSession(child.id)).toBe(replacement);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      expect((await api.providers.db.select().from(sandboxTokens).where(eq(sandboxTokens.id, "replacement-token")))[0]?.revokedAt).toBeNull();
      expect((await api.providers.engineStore.getSession(child.id))?.sandboxId).toBe(newId);
      await api.providers.engineStore.settleUnclaimed(child.id, childThread.id, sent.queueItemId, { outcome: "completed" });
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await watcher.sweepRetention(Date.now() + RETENTION_MS + 60_000);
      expect((await provider.status(newId!)).state).toBe("released");
    } finally { release(); await sweep; blocked.mockRestore(); }
  });

  it("does not recount a destroyed sandbox after its status confirmation failed", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { child, watch } = await seedParkableChild(api, "reclaim-metric", "parent-reclaim-metric");
    const oldId = child.attachment.sandboxId!;
    const status = vi.spyOn(api.providers.engineHost, "sandboxStatus").mockRejectedValueOnce(new Error("status confirmation unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let restoreRecord: (() => void) | undefined;
    try {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
      expect((await provider.status(oldId)).state).toBe("released");
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      const record = vi.spyOn(engineMetrics, "recordSandboxDestroyed").mockImplementation(() => undefined);
      restoreRecord = () => record.mockRestore();
      const destroy = vi.spyOn(provider, "destroy");
      await watcher.sweepRetention(Date.now() + 1);
      expect(destroy).toHaveBeenCalledWith(oldId);
      expect(record).not.toHaveBeenCalled();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { restoreRecord?.(); status.mockRestore(); errors.mockRestore(); }
  });

  it.each(["revive", "retry-failure", "unconfirmed"] as const)("bot failed-destroy repro: %s keeps the durable sandbox owned", async mode => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child } = await seedParkableChild(api, `failed-destroy-${mode}`, "parent-failed-destroy");
    const { engineHost, engineStore: store } = api.providers;
    const sandboxId = child.attachment.sandboxId;
    if (!sandboxId) throw new Error("the child has no sandbox");
    const data = await store.getSession(child.id);
    if (!data) throw new Error("the child session is missing");
    await store.saveSession({ ...data, sandboxId });
    const sandbox = await provider.restore(sandboxId);
    const destroy = vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("injected provider destroy failure"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retry = vi.spyOn(provider, "destroy");
    try {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect((await provider.status(sandboxId)).state).toBe("ready");
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      if (mode === "revive") {
        const rebuilt = await engineHost.childSessionFor(child.id, { parentSessionId: watch.parentSessionId,
          parentThreadId: watch.parentThreadId, actorUserId: "local-user", orgId: "local-org",
          owner: { type: "user", id: "local-user" }, workspace: "/tmp" });
        await expect(rebuilt.attachment.ensureReady({ timeoutMs: 1000 })).resolves.toBeDefined();
        expect(rebuilt).not.toBe(child);
      } else {
        if (mode === "retry-failure") retry.mockRejectedValueOnce(new Error("provider still unavailable"));
        else retry.mockResolvedValueOnce(undefined);
        await watcher.sweepRetention();
        expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
        expect((await store.getSession(child.id))?.sandboxId).toBe(sandboxId);
        expect((await provider.status(sandboxId)).state).toBe("ready");
        await watcher.sweepRetention();
        expect(retry).toHaveBeenCalledTimes(2);
        expect((await provider.status(sandboxId)).state).toBe("released");
        expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
      }
    } finally { destroy.mockRestore(); retry.mockRestore(); errors.mockRestore(); }
  });

  it.each((["timer", "hold"] as const).flatMap(kind =>
    (["failed", "human-failed", "admitted", "unsubmitted"] as const).map(outcome => ({ kind, outcome })),
  ))("counts a $kind $outcome terminal expectation once across retention watchers", async ({ kind, outcome }) => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: 0 });
    const watcher = testChildWatcher(deps);
    const { watch, child, childThread } = await seedParkableChild(api, `loss-once-${kind}-${outcome}`, "parent-loss-once");
    const store = api.providers.engineStore;
    let now = Date.now();
    const id = kind === "hold" ? "ls_loss_once" : "wk_loss_once";
    if (kind === "hold") await store.createLease({ id, sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "continue", createdAt: now, deadlineAt: now + 60_000 });
    else await store.createWakeup({ id, sessionId: child.id, threadId: childThread.id, kind: "timer", status: "pending",
      reason: "continue", prompt: "continue", fireAt: now + 60_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    now = Date.now();
    const grace = vi.spyOn(engineMetrics, "recordChildTerminalSignalAbandoned").mockImplementation(() => undefined);
    const lost = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prompt = vi.spyOn(child, "prompt").mockImplementation(async () => {
      await watcher.sweepRetention();
      throw new Error("injected admission failure");
    });
    try {
      if (outcome === "failed") {
        const wake = new WakeWatcher({ engineStore: store, engineHost: api.providers.engineHost, db: api.providers.db,
          provider, limits: resolveWakeupLimits(process.env), metrics: { signalLost: lost } });
        await wake.sweep(now + 60_001);
        expect(lost).toHaveBeenCalledTimes(1);
      } else if (outcome === "human-failed") {
        expect((await cancelWorkAsHuman(store, child, child.id, id,
          { actorUserId: "local-user", signal: "deliver", signalLost: lost })).kind).toBe("cancelled");
        expect(lost).toHaveBeenCalledTimes(1);
      } else {
        if (kind === "hold") await store.releaseLease(id, "deadline", now, { terminalSignalExpected: true });
        else await store.transitionWakeup(id, ["pending"], "done", { cause: "fired", endedAt: now, terminalSignalExpected: true }, now);
        await watcher.sweepRetention(now + 1);
      }
      prompt.mockRestore();
      if (outcome === "admitted") {
        await store.admitSubmission(child.id, childThread.id, { ...queuedItem("admitted-terminal", childThread.id, ""),
          dispatchId: kind === "hold" ? `lease:${id}:expired` : `wakeup:${id}:terminal`, content: { kind: "signal", signalType: kind === "hold" ? "lease.expired" : "timer.fired", body: "continue" } });
        await store.settleUnclaimed(child.id, childThread.id, "admitted-terminal", { outcome: "completed" });
      }
      const reboot = testChildWatcher(deps);
      await reboot.sweepRetention(now + 2);
      await watcher.sweepRetention(now + 15 * 60_000);
      await reboot.sweepRetention(now + 15 * 60_000 + 1);
      await watcher.sweepRetention(now + 365 * 24 * 60 * 60_000);
      expect(grace).toHaveBeenCalledTimes(outcome === "unsubmitted" ? 1 : 0);
      expect(lost.mock.calls.length + grace.mock.calls.length).toBe(outcome === "admitted" ? 0 : 1);
    } finally { prompt.mockRestore(); grace.mockRestore(); errors.mockRestore(); }
  });

  it.each([0, RETENTION_MS].flatMap(retentionMs =>
    (["hold", "timer", "process", "watch"] as const).map(kind => ({ retentionMs, kind })),
  ))("human cancel retains $kind until admission with retention=$retentionMs", async ({ retentionMs, kind }) => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs }));
    const { watch, child, childThread } = await seedParkableChild(api, "human-cancel-gap", "parent-human-cancel");
    const store = api.providers.engineStore;
    const now = Date.now();
    const id = kind === "hold" ? "ls_human_gap" : "wk_human_gap";
    if (kind === "hold") await store.createLease({ id, sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "preserve scratch", createdAt: now, deadlineAt: now + 60_000 });
    else {
      const row: Wakeup = { id, sessionId: child.id, threadId: childThread.id, kind,
        status: kind === "timer" ? "pending" : "running", reason: "human cancellation", fireAt: now + 60_000,
        logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now };
      if (kind === "timer") await store.createWakeup(row);
      else await store.createWakeupWithLease({ ...row, leaseId: "ls_human_job" }, {
        id: "ls_human_job", sessionId: child.id, threadId: childThread.id, sandboxId: child.attachment.sandboxId,
        ownerKind: kind, ownerId: id, reason: row.reason, createdAt: now, deadlineAt: now + 60_000,
      });
    }
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    // Stale watch/activity clocks make both retention modes eligible immediately.
    await api.providers.db.update(childWatches).set({ settledAt: now - RETENTION_MS - 1 }).where(eq(childWatches.childSessionId, child.id));
    const activity = vi.spyOn(store, "latestActivityAt").mockResolvedValue(now - RETENTION_MS - 1);
    let stateAtAdmission: string | undefined;
    const prompt = vi.spyOn(child, "prompt").mockImplementation(async (content, options) => {
      await watcher.sweepRetention();
      stateAtAdmission = child.attachment.state;
      await store.admitSubmission(child.id, childThread.id, { ...queuedItem("human-terminal", childThread.id, ""), content,
        dispatchId: options?.dispatchId });
      return { queueItemId: "human-terminal", sessionId: child.id, threadId: childThread.id, status: "queued" };
    });
    try {
      expect((await cancelWorkAsHuman(store, child, child.id, id, { actorUserId: "local-user", signal: "deliver" })).kind).toBe("cancelled");
      expect(stateAtAdmission).toBe("ready");
      await store.settleUnclaimed(child.id, childThread.id, "human-terminal", { outcome: "completed" });
      await watcher.sweepRetention();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { prompt.mockRestore(); activity.mockRestore(); }
  });

  it("human cancellation of child updates retains the recipient until event.ended admission", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "human-event-gap", "parent-human-event");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createLease({ id: "ls_event_keep", sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "keep while arming", createdAt: now, deadlineAt: now + 60_000 });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    const id = "wk_child_events:grandchild-human";
    await store.createWakeup({ id, sessionId: child.id, threadId: childThread.id, kind: "event", status: "running",
      reason: "grandchild updates", eventMatch: { childSessionId: "grandchild-human", clauses: [], once: false, self: [] },
      logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    await store.releaseLease("ls_event_keep", "cancelled", now);
    const prompt = vi.spyOn(child, "prompt").mockImplementation(async (content, options) => {
      await watcher.sweepRetention();
      expect(child.attachment.state).toBe("ready");
      expect(await store.getWakeup(id)).toMatchObject({ status: "cancelled", terminalSignalExpected: true });
      await store.admitSubmission(child.id, childThread.id, { ...queuedItem("human-event-terminal", childThread.id, ""),
        content, dispatchId: options?.dispatchId });
      return { queueItemId: "human-event-terminal", sessionId: child.id, threadId: childThread.id, status: "queued" };
    });
    try {
      expect((await cancelWorkAsHuman(store, child, child.id, id, { actorUserId: "local-user", signal: "deliver" })).kind).toBe("cancelled");
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(await store.getQueueItemByDispatchId(child.id, `wakeup:${id}:terminal`)).not.toBeNull();
      await store.settleUnclaimed(child.id, childThread.id, "human-event-terminal", { outcome: "completed" });
      await store.transitionWakeup(id, ["cancelled"], "running", {}, Date.now());
      await child.options.wakeups?.cancel(id);
      expect((await store.getWakeup(id))?.terminalSignalExpected).not.toBe(true);
      expect(prompt).toHaveBeenCalledTimes(1);
      await watcher.sweepRetention();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { prompt.mockRestore(); }
  });

  it.each((["replace", "profile", "move"] as const).flatMap(action =>
    (["hold", "process"] as const).map(kind => ({ action, kind })),
  ))("deferred $action cancellation of $kind protects provisioning beyond terminal grace", async ({ action, kind }) => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "deferred-human-gap", "parent-deferred-human");
    const { engineStore: store, engineHost } = api.providers;
    const now = Date.now();
    const id = kind === "hold" ? "ls_deferred_gap" : "wk_deferred_gap";
    const dispatchId = kind === "hold" ? `lease:${id}:released` : `wakeup:${id}:terminal`;
    const lease = { id: "ls_deferred_gap", sessionId: child.id, threadId: childThread.id, ownerKind: kind,
      reason: "preserve scratch", createdAt: now, deadlineAt: now + 60_000 };
    if (kind === "hold") await store.createLease(lease);
    else await store.createWakeupWithLease({ id, sessionId: child.id, threadId: childThread.id, kind,
      leaseId: lease.id, status: "running", reason: lease.reason, logOffset: 0, logTail: "", eventCount: 0,
      createdAt: now, updatedAt: now }, { ...lease, ownerId: id });
    const terminal = () => kind === "hold" ? store.getLease(id) : store.getWakeup(id);
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    let stateDuringProvision: string | undefined;
    let reclaimedDuringProvision: number | null | undefined;
    let expectationDuringProvision: boolean | undefined;
    let restoreClock: (() => void) | undefined;
    let stateAtSignalAdmission: string | undefined;
    const admit = store.admitSubmission.bind(store);
    const admission = vi.spyOn(store, "admitSubmission").mockImplementation(async (...args) => {
      if (args[0] === child.id && args[2].dispatchId === dispatchId) {
        await watcher.sweepRetention(Date.now());
        stateAtSignalAdmission = engineHost.liveSession(child.id)?.attachment.state;
      }
      return admit(...args);
    });
    provider.onCreate = async () => {
      expectationDuringProvision = (await terminal())?.terminalSignalExpected;
      await watcher.sweepRetention(now + CHILD_TERMINAL_SIGNAL_GRACE_MS + 60_000);
      stateDuringProvision = engineHost.liveSession(child.id)?.attachment.state;
      reclaimedDuringProvision = (await watchRow(api!, child.id))?.sandboxReclaimedAt;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + CHILD_TERMINAL_SIGNAL_GRACE_MS + 60_000);
      restoreClock = () => clock.mockRestore();
    };
    try {
      // Child sessions cannot move through HTTP. Exercise the same deferred
      // cancel/provision/send protocol here; the route suite verifies owner moves.
      const response = action === "move" ? await (async () => {
        const stopped = await cancelAllWorkAsHuman(store, child, child.id, {}, {
          actorUserId: "local-user", signal: "defer", note: "They moved the session to another workspace.",
        });
        await child.attachment.replace();
        await stopped.sendSignals(child);
        return new Response("{}", { status: 200 });
      })() : await fetch(`${api.baseUrl}/api/sessions/${child.id}${action === "replace" ? "/sandbox/replace?force=true" : ""}`, {
        method: action === "replace" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        ...(action === "replace" ? {} : { body: JSON.stringify({ force: true, profile: "full" }) }),
      });
      provider.onCreate = undefined;
      expect(response.status, await response.text()).toBe(200);
      expect(stateDuringProvision).toBe("provisioning");
      expect(reclaimedDuringProvision).toBeNull();
      expect(expectationDuringProvision).toBe(true);
      expect(await store.getQueueItemByDispatchId(child.id, dispatchId)).not.toBeNull();
      expect(stateAtSignalAdmission).toBe("ready");
      expect((await terminal())?.terminalSignalStartedAt).toBe(now + CHILD_TERMINAL_SIGNAL_GRACE_MS + 60_000);
    } finally { admission.mockRestore(); restoreClock?.(); provider.onCreate = undefined; }
  });

  it.each(["hold", "timer", "process", "watch"] as const)("silent agent cancel of %s does not retain the sandbox", async kind => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "agent-cancel-gap", "parent-agent-cancel");
    const store = api.providers.engineStore;
    const now = Date.now();
    const id = kind === "hold" ? "ls_agent_cancel" : "wk_agent_cancel";
    if (kind === "hold") await store.createLease({ id, sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "scratch", createdAt: now, deadlineAt: now + 60_000 });
    else {
      const row: Wakeup = { id, sessionId: child.id, threadId: childThread.id, kind,
        status: kind === "timer" ? "pending" : "running", reason: "agent cancellation", fireAt: now + 60_000,
        logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now };
      if (kind === "timer") await store.createWakeup(row);
      else await store.createWakeupWithLease({ ...row, leaseId: "ls_agent_job" }, {
        id: "ls_agent_job", sessionId: child.id, threadId: childThread.id, sandboxId: child.attachment.sandboxId,
        ownerKind: kind, ownerId: id, reason: row.reason, createdAt: now, deadlineAt: now + 60_000,
      });
    }
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    expect(await child.options.wakeups?.cancel(id)).toMatchObject({ kind: kind === "hold" ? "lease" : "wakeup" });
    const row = kind === "hold" ? await store.getLease(id) : await store.getWakeup(id);
    expect(row?.terminalSignalExpected).not.toBe(true);
    expect(row?.terminalSignalStartedAt).toBeUndefined();
    await watcher.sweepRetention();
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
  });

  it("does not query dispatch IDs for historical terminal expectations", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "terminal-history", "parent-terminal-history");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createLease({ id: "ls_old_expected", sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "old scratch", createdAt: now, deadlineAt: now + 60_000 });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await store.releaseLease("ls_old_expected", "deadline", now, { terminalSignalExpected: true });
    await store.createWakeup({ id: "wk_old_expected", sessionId: child.id, threadId: childThread.id, kind: "timer", status: "done",
      reason: "old timer", endedAt: now, terminalSignalExpected: true, logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    const dispatch = vi.spyOn(store, "getQueueItemByDispatchId");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await watcher.sweepRetention(now + CHILD_TERMINAL_SIGNAL_GRACE_MS + 1);
      expect(dispatch.mock.calls.filter(([, id]) => id === "lease:ls_old_expected:expired" || id === "wakeup:wk_old_expected:terminal")).toEqual([]);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { dispatch.mockRestore(); errors.mockRestore(); }
  });

  it("new bot repro 3: retains the sandbox between hold release and lease.expired admission", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "new-bot-hold-gap", "parent-new-bot-hold");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createLease({ id: "ls_new_bot_gap", sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "preserve scratch", createdAt: now, deadlineAt: now + 60_000 });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    let stateAtAdmission: string | undefined;
    const prompt = vi.spyOn(child, "prompt").mockImplementation(async (content, options) => {
      expect(await store.countActiveLeases(child.id)).toBe(0);
      await watcher.sweepRetention();
      stateAtAdmission = child.attachment.state;
      await store.admitSubmission(child.id, childThread.id, { ...queuedItem("hold-terminal-turn", childThread.id, ""),
        content, dispatchId: options?.dispatchId });
      return { queueItemId: "hold-terminal-turn", sessionId: child.id, threadId: childThread.id, status: "queued" };
    });
    try {
      await childDelivery!.sweep(now + 60_001);
      expect(prompt).toHaveBeenCalled();
      expect(stateAtAdmission).toBe("ready");
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      await watcher.sweepRetention();
      expect(child.attachment.state).toBe("ready");
      await store.settleUnclaimed(child.id, childThread.id, "hold-terminal-turn", { outcome: "completed" });
      await watcher.sweepRetention();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { prompt.mockRestore(); }
  });

  it.each([true, false])("bounds released-hold retention across reboot (terminal expected=%s)", async expected => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: 0 });
    const watcher = testChildWatcher(deps);
    const { watch, child, childThread } = await seedParkableChild(api, "hold-terminal-bound", "parent-hold-bound");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createLease({ id: "ls_hold_bound", sessionId: child.id, threadId: childThread.id, ownerKind: "hold",
      reason: "preserve scratch", createdAt: now, deadlineAt: now + 60_000 });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    const prompt = vi.spyOn(child, "prompt").mockRejectedValueOnce(new Error("hold expiry admission unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      if (expected) {
        await childDelivery!.sweep(now + 60_001);
        expect(prompt).toHaveBeenCalledTimes(1);
        expect((await store.getLease("ls_hold_bound"))?.terminalSignalExpected).toBe(true);
      } else await store.releaseLease("ls_hold_bound", "cancelled", now);
      prompt.mockRestore();
      const reboot = testChildWatcher(deps);
      await reboot.rearm();
      await reboot.sweepRetention();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt === null).toBe(expected);
      await reboot.sweepRetention(now + 60_001 + CHILD_TERMINAL_SIGNAL_GRACE_MS + 1);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
      expect(child.attachment.state).toBe("released");
      expect((await store.getWakeup(`wk_child_events:${child.id}`))?.status).not.toBe("running");
      expect(errors.mock.calls.some(args => String(args[0]).includes("terminal signal admission was not observed"))).toBe(false);
      if (expected) expect((await store.getLease("ls_hold_bound"))?.terminalSignalLossReportedAt).toBeDefined();
    } finally { prompt.mockRestore(); errors.mockRestore(); }
  });

  it("new bot repro 4: failed timer admission does not retain a non-hibernating child after rearm and a year", async () => {
    const provider = new HibernatingChildProvider();
    provider.hibernation = false;
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: 0 });
    const watcher = testChildWatcher(deps);
    const { watch, child, childThread } = await seedParkableChild(api, "new-bot-timer-year", "parent-new-bot-timer-year");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createWakeup({ id: "wk_new_bot_timer_year", sessionId: child.id, threadId: childThread.id, kind: "timer", status: "pending",
      reason: "continue", prompt: "Continue with scratch", fireAt: now + 60_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    const prompt = vi.spyOn(child, "prompt").mockRejectedValueOnce(new Error("one failed timer admission"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await childDelivery!.sweep(now + 60_001);
      expect(prompt).toHaveBeenCalledTimes(1);
      prompt.mockRestore();
      const reboot = testChildWatcher(deps);
      await reboot.rearm();
      await childDelivery!.sweep(now + 60_002);
      expect((await store.getWakeup("wk_new_bot_timer_year"))?.status).toBe("done");
      expect(await store.getQueueItemByDispatchId(child.id, "wakeup:wk_new_bot_timer_year:terminal")).toBeNull();
      await reboot.sweepRetention(now + 365 * 24 * 60 * 60_000);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
      expect(child.attachment.state).toBe("released");
      expect((await store.getWakeup(`wk_child_events:${child.id}`))?.status).not.toBe("running");
    } finally { prompt.mockRestore(); errors.mockRestore(); }
  });

  it("bot repro 3: retains the sandbox between timer completion and terminal admission", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "bot-timer-gap", "parent-bot-timer");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createWakeup({ id: "wk_bot_timer", sessionId: child.id, threadId: childThread.id, kind: "timer", status: "pending",
      reason: "follow up", prompt: "Continue with workspace", fireAt: now + 1000, logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await store.transitionWakeup("wk_bot_timer", ["pending"], "done", { cause: "fired", endedAt: Date.now(), terminalSignalExpected: true }, Date.now());
    await watcher.sweepRetention();
    expect(api.providers.engineHost.liveSession(child.id)).not.toBeNull();
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
    await store.admitSubmission(child.id, childThread.id, { ...queuedItem("timer-turn", childThread.id, ""),
      dispatchId: "wakeup:wk_bot_timer:terminal", content: { kind: "signal", signalType: "timer.fired", body: "Continue with workspace" } });
    await watcher.sweepRetention();
    expect(api.providers.engineHost.liveSession(child.id)).not.toBeNull();
    await store.settleUnclaimed(child.id, childThread.id, "timer-turn", { outcome: "completed" });
    await watcher.sweepRetention();
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
  });

  it.each([
    { label: "a refused background start", row: { kind: "process" as const, status: "lost" as const, cause: "pid_missing" as const, command: "sleep 9", execId: "job-1" }, bounded: false },
    { label: "a bad timer row", row: { kind: "timer" as const, status: "lost" as const }, bounded: false },
    { label: "a failed terminal delivery", row: { kind: "timer" as const, status: "done" as const, cause: "fired" as const, prompt: "ping", terminalSignalExpected: true }, bounded: true },
  ])("stops waiting for the terminal signal of $label after the grace window", async ({ row, bounded }) => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "xl-no-signal", "parent-xl-no-signal");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ended = Date.now();
    await api.providers.engineStore.createWakeup({ id: "wk_xl_ended", sessionId: child.id, threadId: childThread.id, reason: "work",
      logOffset: 0, logTail: "", eventCount: 0, createdAt: ended - 1000, updatedAt: ended, endedAt: ended, ...row });
    try {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await watcher.sweepRetention(ended + 1000);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt === null).toBe(bounded);
      await watcher.sweepRetention(ended + CHILD_TERMINAL_SIGNAL_GRACE_MS + 1);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
      expect(api.providers.engineHost.liveSession(child.id)).toBeNull();
      expect((await api.providers.engineStore.getWakeup(`wk_child_events:${child.id}`))?.status).not.toBe("running");
      expect(errors.mock.calls.some(args => String(args[0]).includes("terminal signal admission was not observed"))).toBe(bounded);
      await watcher.sweepRetention(ended + 365 * 24 * 60 * 60_000);
      expect((await api.providers.engineStore.getWakeup(`wk_child_events:${child.id}`))?.status).not.toBe("running");
    } finally { errors.mockRestore(); }
  });

  it("retains an ended timer across reboot and a failed terminal admission", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: 0 });
    const watcher = testChildWatcher(deps);
    const { watch, child, childThread } = await seedParkableChild(api, "bot-timer-reboot", "parent-bot-timer-reboot");
    const store = api.providers.engineStore;
    const now = Date.now();
    await store.createWakeup({ id: "wk_bot_reboot", sessionId: child.id, threadId: childThread.id, kind: "timer", status: "pending",
      reason: "follow up", prompt: "Continue with workspace", fireAt: now + 60_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    const prompt = vi.spyOn(child, "prompt").mockImplementation(async () => {
      expect((await store.getWakeup("wk_bot_reboot"))?.status).toBe("done");
      await watcher.sweepRetention();
      expect(api!.providers.engineHost.liveSession(child.id)).not.toBeNull();
      throw new Error("terminal admission unavailable");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await childDelivery!.sweep(now + 60_001);
      expect(prompt).toHaveBeenCalled();
      const reboot = testChildWatcher(deps);
      await reboot.sweepRetention();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      expect(api.providers.engineHost.liveSession(child.id)).not.toBeNull();
      expect((await store.getWakeup("wk_bot_reboot"))?.terminalSignalExpected).toBe(true);
      await reboot.sweepRetention(Date.now() + CHILD_TERMINAL_SIGNAL_GRACE_MS + 1);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { prompt.mockRestore(); errors.mockRestore(); }
  });

  it.each([false, true])("bot repro 5: retention off preserves a recently finished human turn after skipped park (takeover=%s)", async takeover => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0 }));
    const { watch, child, childThread } = await seedParkableChild(api, "bot-human-gap", "parent-bot-human");
    const store = api.providers.engineStore;
    await store.admitSubmission(child.id, childThread.id, { ...queuedItem("human-followup", childThread.id, "Human followup"), author: { id: "local-user" } });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await store.settleUnclaimed(child.id, childThread.id, "human-followup", { outcome: "completed" });
    if (takeover) await api.providers.db.update(childWatches).set({ queueItemId: "human-followup" })
      .where(eq(childWatches.childSessionId, child.id));
    await watcher.sweepRetention();
    expect(api.providers.engineHost.liveSession(child.id)).not.toBeNull();
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
    // The default grace matches the 30-minute platform idle timeout.
    await watcher.sweepRetention(Date.now() + 29 * 60_000);
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
    await watcher.sweepRetention(Date.now() + 30 * 60_000 + 1);
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
  });

  it("uses the configured idle grace when warm retention is off", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: 0, idleGraceMs: 5 * 60_000 }));
    const { watch, child, childThread } = await seedParkableChild(api, "xl-idle-grace", "parent-xl-idle-grace");
    const store = api.providers.engineStore;
    await store.admitSubmission(child.id, childThread.id, { ...queuedItem("human-chat", childThread.id, "Human chat"), author: { id: "local-user" } });
    watcher.arm(watch);
    await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
    await store.settleUnclaimed(child.id, childThread.id, "human-chat", { outcome: "completed" });
    await watcher.sweepRetention(Date.now() + 4 * 60_000);
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
    await watcher.sweepRetention(Date.now() + 5 * 60_000 + 1);
    expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
  });

  it("destroys a parked handle once when the revoke fails and the sweep retries", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: RETENTION_MS }));
    const { watch, child } = await seedParkableChild(api, "xl-destroy-once", "parent-xl-destroy-once");
    const original = sandboxTokenAuth.revokeSandboxTokens;
    const revoke = vi.spyOn(sandboxTokenAuth, "revokeSandboxTokens");
    const destroySandbox = vi.spyOn(api.providers.engineHost, "destroySandbox");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
      // An api restart evicted the cached session: the sweep reclaims through the parked handle.
      const stored = await api.providers.engineStore.getSession(child.id);
      expect(stored).not.toBeNull();
      if (!stored) throw new Error("missing child session");
      // Exercise the session handle fallback as well as the parked handle.
      await api.providers.engineStore.saveSession({ ...stored, sandboxId: provider.suspendCalls[0] });
      api.providers.engineHost.evictCache(child.id);
      revoke.mockRejectedValue(new Error("token store unavailable"));
      await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
      expect(destroySandbox).toHaveBeenCalledTimes(1);
      expect((await watchRow(api, child.id))?.parkedSandboxId).toBeNull();
      expect((await api.providers.engineStore.getSession(child.id))?.sandboxId).toBeUndefined();
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).toBeNull();
      revoke.mockImplementation(original);
      const reboot = testChildWatcher(childrenDeps(api, { retentionMs: RETENTION_MS }));
      await reboot.sweepRetention(Date.now() + RETENTION_MS + 60_000);
      expect(destroySandbox).toHaveBeenCalledTimes(1);
      expect((await watchRow(api, child.id))?.sandboxReclaimedAt).not.toBeNull();
    } finally { revoke.mockRestore(); destroySandbox.mockRestore(); errors.mockRestore(); }
  });

  it.each(["eager", "sweep"] as const)("bot repro 8: retries token revocation before stamping %s reclaim", async mode => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const watcher = testChildWatcher(childrenDeps(api, { retentionMs: mode === "eager" ? 0 : RETENTION_MS }));
    const { watch, child } = await seedParkableChild(api, `bot-revoke-${mode}`, `parent-bot-revoke-${mode}`);
    const original = sandboxTokenAuth.revokeSandboxTokens;
    const revoke = vi.spyOn(sandboxTokenAuth, "revokeSandboxTokens");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      if (mode === "eager") revoke.mockRejectedValue(new Error("token store unavailable"));
      watcher.arm(watch);
      await waitFor(async () => (await watchRow(api!, child.id))?.settled === true);
      if (mode === "sweep") {
        await vi.waitFor(() => expect(provider.suspendCalls).toHaveLength(1));
        revoke.mockRejectedValue(new Error("token store unavailable"));
        await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
      } else await vi.waitFor(() => expect(revoke).toHaveBeenCalled());
      expect((await watchRow(api!, child.id))?.sandboxReclaimedAt).toBeNull();
      const [token] = await api!.providers.db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, child.id));
      expect(token?.revokedAt).toBeNull();
      revoke.mockImplementation(original);
      await watcher.sweepRetention(Date.now() + RETENTION_MS + 60_000);
      expect((await watchRow(api!, child.id))?.sandboxReclaimedAt).not.toBeNull();
      const [retried] = await api!.providers.db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, child.id));
      expect(retried?.revokedAt).not.toBeNull();
    } finally { revoke.mockRestore(); errors.mockRestore(); }
  });

  it("parks a settled child by suspending its sandbox: cache kept, tokens kept, status hibernated", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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

  it("retention sweep: skips a child while it holds a lease or a pending timer (fix wave 3, concurrency M2)", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = testChildWatcher(deps);
    const { engineStore } = api.providers;

    const { watch, childThread } = await seedParkableChild(api, "child-leased", "parent-leased");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);

    // A person asked the settled child for a 48h build after the settle.
    await engineStore.createLease({
      id: "ls_long", sessionId: "child-leased", ownerKind: "process", ownerId: "wk_long", reason: "long build",
      createdAt: Date.now(), deadlineAt: Date.now() + 48 * 3_600_000,
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    expect((await watchRow(api, "child-leased"))?.sandboxReclaimedAt).toBeNull();

    await engineStore.releaseLease("ls_long", "owner_ended", Date.now());
    await engineStore.createWakeup({
      id: "wk_timer", sessionId: "child-leased", threadId: childThread.id, kind: "timer", status: "pending", reason: "later",
      prompt: "later", fireAt: Date.now() + 3_600_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 2);
    expect((await watchRow(api, "child-leased"))?.sandboxReclaimedAt).toBeNull();

    await engineStore.transitionWakeup("wk_timer", ["pending"], "cancelled", { cause: "cancelled" }, Date.now());
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 3);
    expect((await watchRow(api, "child-leased"))?.sandboxReclaimedAt).not.toBeNull();
    log.mockRestore();
  });

  it("retention sweep: skips a child while it holds a running event waiter (spec 2026-10-15, F2)", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = testChildWatcher(deps);
    const { engineStore } = api.providers;

    const { watch, childThread } = await seedParkableChild(api, "child-event-held", "parent-event-held");
    watcher.arm(watch);
    await waitFor(async () => provider.suspendCalls.length === 1);

    // An event waiter holds no lease (INV-E3), so it is not "leased"; it
    // keeps the sandbox past the retention window all the same.
    await engineStore.createWakeup({
      id: "wk_event_held", sessionId: "child-event-held", threadId: childThread.id, kind: "event", status: "running",
      reason: "wait for CI", deadlineAt: Date.now() + 3_600_000, logOffset: 0, logTail: "", eventCount: 0,
      createdAt: Date.now(), updatedAt: Date.now(), subjects: ["github:acme/lean-proofs#42"],
      eventMatch: { clauses: [{ key: "github.check_run.completed" }], once: true, self: [] },
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 1);
    expect((await watchRow(api, "child-event-held"))?.sandboxReclaimedAt).toBeNull();

    await engineStore.transitionWakeup("wk_event_held", ["running"], "cancelled", { cause: "cancelled" }, Date.now());
    await watcher.sweepRetention(Date.now() + RETENTION_MS + 2);
    expect((await watchRow(api, "child-event-held"))?.sandboxReclaimedAt).not.toBeNull();
    log.mockRestore();
  });

  it("retention sweep: skips a parked child a user has since woken", async () => {
    const provider = new HibernatingChildProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const deps = childrenDeps(api, { retentionMs: RETENTION_MS });
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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
    const watcher = testChildWatcher(deps);
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


describe("registry capacity child admission", () => {
  it.each(["full", "unknown"] as const)("warns and starts from an older base image when capacity is %s", async (status) => {
    const provider = makeImageRecordingProvider();
    const create = provider.create.bind(provider);
    vi.spyOn(provider, "create").mockImplementation(async (opts) => {
      const sandbox = await create(opts);
      vi.spyOn(sandbox, "exec").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      return sandbox;
    });
    api = await bootTestApi({ sandboxProvider: provider });
    await seedBaseSourceWithBake(api, "existing-base", "full", "registry/base:older");
    const deps = childrenDeps(api, { sandboxBacked: true });
    const parent = await api.providers.engineHost.sessionFor("parent-fallback", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    vi.spyOn(deps.prebuildService, "assertRegistryCapacity").mockRejectedValue(new RegistryCapacityError(status));
    const result = await buildChildSpawner(deps, testChildWatcher(deps))({ prompt: "work" }, {
      parentSessionId: parent.id, parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user", owner: { type: "user", id: "local-user" },
    });
    expect(result.warnings).toEqual([expect.stringContaining("registry/base:older")]);
    expect(result.warnings?.[0]).toContain("New image bakes are blocked");
    const child = deps.engineHost.liveSession(result.childSessionId)!;
    expect((await child.options.specProvider!()).image).toBe("registry/base:older");
    await child.attachment.ensureReady({ timeoutMs: 5000 });
    expect(await deps.db.select().from(childWatches)).toHaveLength(1);
  });

  it("allows the configured stock image when no baked image exists", async () => {
    api = await bootTestApi({ sandboxProvider: makeImageRecordingProvider(), defaultImage: "stock:existing" });
    const deps = childrenDeps(api, { sandboxBacked: true });
    const parent = await api.providers.engineHost.sessionFor("parent-stock", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    vi.spyOn(deps.prebuildService, "assertRegistryCapacity").mockRejectedValue(new RegistryCapacityError("full"));
    const result = await buildChildSpawner(deps, testChildWatcher(deps))({ prompt: "work" }, {
      parentSessionId: parent.id, parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user", owner: { type: "user", id: "local-user" },
    });
    expect(result.warnings?.[0]).toContain("stock:existing");
  });

  it("does not use a disabled source to bypass the capacity guard", async () => {
    api = await bootTestApi({ sandboxProvider: makeImageRecordingProvider() });
    await seedBaseSourceWithBake(api, "disabled-base", "full", "registry/base:disabled");
    await api.providers.db.update(imageSources).set({ enabled: false }).where(eq(imageSources.id, "disabled-base"));
    expect(await api.providers.engineHost.resolveChildStartupImage({
      userId: "local-user", orgId: "local-org", workspace: "",
    })).toBeNull();
  });

  it("rejects before child session, watch, repo, or working directory creation", async () => {
    api = await bootTestApi();
    const deps = childrenDeps(api, { sandboxBacked: true });
    const parent = await api.providers.engineHost.sessionFor("parent-capacity", {
      userId: "local-user", orgId: "local-org", workspace: "/tmp",
    });
    const guard = vi.spyOn(deps.prebuildService, "assertRegistryCapacity").mockRejectedValue(new RegistryCapacityError("full"));
    const create = vi.spyOn(deps.engineHost, "childSessionFor");
    const spawner = buildChildSpawner(deps, testChildWatcher(deps));
    await expect(spawner({ prompt: "work" }, {
      parentSessionId: parent.id, parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user", owner: { type: "user", id: "local-user" },
    })).rejects.toThrow("registry full");
    expect(guard).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(await deps.db.select().from(childWatches)).toHaveLength(0);
    expect(await deps.db.select().from(sessionRepos)).toHaveLength(0);
    expect(readdirSync(deps.workspaceRoot!)).toHaveLength(0);
  });
});
