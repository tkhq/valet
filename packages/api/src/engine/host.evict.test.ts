/**
 * Shutdown must EVICT, never DESTROY (regression for the dev-restart
 * data-loss bug): `Session.destroy()` calls `store.deleteSession()`, which
 * erases the session's threads/queue items/transcript. `main.ts`'s
 * shutdown handler used `destroyAll()` and every graceful restart (tsx
 * watch reload, Ctrl-C on `make dev-local`) wiped live sessions' durable
 * state — SIGKILL restart tests never caught it because the handler never
 * ran. `evictAll()` is the shutdown-safe variant: timers suspended, cache
 * dropped, store untouched.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { eq } from "drizzle-orm";
import { agentSessions, assistants, sessionConfigInvalidations } from "../schema/index.js";
import { VirtualSandboxProvider } from "@valet/engine";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

describe("EngineHost.evictAll", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it.each(["owner", "claim-in-flight", "archive", "shutdown"] as const)("does not lose %s eviction during an active turn", async kind => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const nextCredentials: Array<string | undefined> = [];
    faux.appendResponses([async () => { entered(); await held; return fauxAssistantMessage("first done"); }, async () => {
      const live = api!.providers.engineHost.liveSession(session.id)!;
      nextCredentials.push((await live.credentialProvider().get("linear"))?.accessToken);
      return fauxAssistantMessage("next done");
    }]);
    api = await bootTestApi();
    const { engineHost: host, engineStore: store, db, engineCredentials } = api.providers;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const moving = kind === "owner" || kind === "claim-in-flight";
    const session = moving ? await host.sessionFor("active-owner-move", meta)
      : await defaultAssistantSessionFor(api.providers, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    await session.setModel("claude-haiku-4-5");
    await engineCredentials.save({ type: "user", id: "local-user" }, "linear", { type: "api_key", apiKey: "old-owner" });
    await engineCredentials.save({ type: "user", id: "test-member" }, "linear", { type: "api_key", apiKey: "new-owner" });
    if (moving) await db.insert(agentSessions).values({ id: session.id, userId: "local-user", orgId: "local-org", workspace: "/tmp",
      ownerType: "user", ownerId: "local-user", status: "active", createdAt: 1, updatedAt: 1 });
    let allowClaim!: () => void;
    const heldClaim = new Promise<void>(resolve => { allowClaim = resolve; });
    let claimEntered!: () => void;
    const claiming = new Promise<void>(resolve => { claimEntered = resolve; });
    const originalClaim = store.claimSubmission.bind(store);
    const claim = kind === "claim-in-flight" ? vi.spyOn(store, "claimSubmission").mockImplementationOnce(async args => {
      claimEntered(); await heldClaim; return originalClaim(args);
    }) : undefined;
    const first = await session.prompt("hold the active turn");
    try {
      if (kind === "claim-in-flight") {
        await claiming;
        expect(session.thread().hasActiveRun).toBe(false);
      } else await entering;
      expect(session.hasActiveExecution).toBe(true);
      expect(await session.beginReclaim()).toBe(false);
      if (moving) await db.update(agentSessions).set({ ownerId: "test-member", userId: "test-member" }).where(eq(agentSessions.id, session.id));
      if (kind === "archive") await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.sessionId, session.id));
      if (kind === "shutdown") host.evictAll();
      else {
        if (kind === "archive") {
          const [assistant] = await db.select().from(assistants).where(eq(assistants.sessionId, session.id));
          await expect(host.assistantSessionFor(assistant!.id, { actorUserId: "local-user", orgId: "local-org" })).rejects.toMatchObject({ code: "assistant_archived" });
        } else await host.invalidateSession(session.id);
        expect(await db.select().from(sessionConfigInvalidations)).toHaveLength(1);
      }
      const next = await session.prompt("next turn on fresh configuration", { queueMode: "followup" });
      if (kind === "shutdown") {
        expect(host.isLive(session.id)).toBe(false);
        await expect(host.sessionFor(session.id, meta)).rejects.toThrow("shutting down");
      }
      else expect(host.liveSession(session.id)).toBe(session);
      expect(await store.getQueueItem(session.id, next.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      allowClaim();
      await entering;
      release();
      expect((await session.thread().awaitResult(first.queueItemId)).outcome).toBe("completed");
      if (moving) {
        await vi.waitFor(() => expect(nextCredentials).toEqual(["new-owner"]), { timeout: 10000 });
        expect((await store.getQueueItem(session.id, next.queueItemId))?.attemptCount).toBe(1);
        expect(host.liveSession(session.id)).not.toBe(session);
        expect(await db.select().from(sessionConfigInvalidations)).toHaveLength(0);
      } else {
        await vi.waitFor(() => expect(session.hasActiveExecution).toBe(false));
        await vi.waitFor(() => expect(host.liveSession(session.id)).toBeNull());
        expect(nextCredentials).toEqual([]);
        expect(await store.getQueueItem(session.id, next.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      }
    } finally { allowClaim(); release(); await session.thread().kick(); claim?.mockRestore(); faux.unregister(); vi.unstubAllEnvs(); }
  });

  it.each(["followup", "inject", "collect", "steer"] as const)("runs another thread with new credentials while the old turn drains and fences %s on its successor", async queueMode => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const credentials: Array<string | undefined> = [];
    faux.appendResponses([async () => { entered(); await held; return fauxAssistantMessage("A done"); }, async () => {
      credentials.push((await api!.providers.engineHost.liveSession(original.id)!.credentialProvider().get("linear"))?.accessToken);
      return fauxAssistantMessage("B done");
    }, async () => {
      credentials.push((await api!.providers.engineHost.liveSession(original.id)!.credentialProvider().get("linear"))?.accessToken);
      return fauxAssistantMessage("A next done");
    }]);
    api = await bootTestApi();
    const { engineHost: host, engineStore: store, db, engineCredentials } = api.providers;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const original = await host.sessionFor("per-thread-handoff", meta);
    await original.setModel("claude-haiku-4-5");
    await db.insert(agentSessions).values({ id: original.id, userId: "local-user", orgId: "local-org", workspace: "/tmp",
      ownerType: "user", ownerId: "local-user", status: "active", createdAt: 1, updatedAt: 1 });
    await engineCredentials.save({ type: "user", id: "test-member" }, "linear", { type: "api_key", apiKey: "new-owner" });
    const first = await original.prompt("A hold");
    try {
      await entering;
      await db.update(agentSessions).set({ ownerId: "test-member", userId: "test-member" }).where(eq(agentSessions.id, original.id));
      await host.invalidateSession(original.id);
      const other = await original.createThread("web:other");
      const b = await other.submitPrompt("B must not wait", {});
      await vi.waitFor(async () => expect(await store.getQueueItem(original.id, b.queueItemId)).toMatchObject({ status: "settled", attemptCount: 1 }), { timeout: 5000 });
      expect(credentials).toEqual(["new-owner"]);
      expect(await store.getQueueItem(original.id, first.queueItemId)).toMatchObject({ status: "running", attemptCount: 1 });
      const rebuilt = host.liveSession(original.id)!;
      const next = await rebuilt.prompt("A next", { queueMode });
      expect(await store.getQueueItem(original.id, next.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      expect(rebuilt).not.toBe(original);
      expect(rebuilt.attachment).toBe(original.attachment);
      expect(await rebuilt.beginReclaim()).toBe(false);
      release();
      await vi.waitFor(async () => expect(await store.getQueueItem(original.id, next.queueItemId)).toMatchObject({ status: "settled", attemptCount: 1 }), { timeout: 10000 });
      expect(credentials).toEqual(["new-owner", "new-owner"]);
    } finally { release(); await original.thread().kick(); faux.unregister(); vi.unstubAllEnvs(); }
  });

  it("fences a build that finishes after terminal shutdown", async () => {
    api = await bootTestApi();
    const { engineHost: host, engineStore: store } = api.providers;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const getSession = store.getSession.bind(store);
    const reading = vi.spyOn(store, "getSession").mockImplementationOnce(async id => { entered(); await held; return getSession(id); });
    const building = host.sessionFor("late-shutdown-build", { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
    try {
      await entering;
      host.evictAll();
      release();
      const late = await building;
      expect(host.liveSession(late.id)).toBeNull();
      const sent = await late.prompt("must wait for next boot");
      expect(await store.getQueueItem(late.id, sent.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      expect(late.isExecutionFenced).toBe(true);
      expect(late.hasActiveExecution).toBe(false);
    } finally { release(); reading.mockRestore(); await building; }
  });

  it("keeps the cached owner while pending release can still fail", async () => {
    let rejectRelease!: (error: Error) => void;
    let releaseStarted = false;
    class PendingReleaseProvider extends VirtualSandboxProvider {
      async release(_id: string): Promise<void> {
        if (releaseStarted) return;
        releaseStarted = true;
        return new Promise<void>((_resolve, reject) => { rejectRelease = reject; });
      }
    }
    api = await bootTestApi({ sandboxProvider: new PendingReleaseProvider() });
    const host = api.providers.engineHost;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const session = await host.sessionFor("pending-release-failure", meta);
    await session.attachment.ensureReady({ timeoutMs: 5000 });
    session.attachment.reportFailure(session.attachment.currentEpoch(), new Error("test liveness failure"));
    const destroying = session.attachment.destroy();
    // Install the rejection handler before rejecting the provider's pending release.
    const failed = expect(destroying).rejects.toThrow("test release failure");
    await vi.waitFor(() => expect(session.attachment.state).toBe("released"));
    expect(session.attachment.isDestroying).toBe(true);
    expect(host.liveSession(session.id)).toBe(session);
    expect(await host.sessionFor(session.id, meta)).toBe(session);
    rejectRelease(new Error("test release failure"));
    await failed;
    expect(session.attachment.isDestroying).toBe(false);
    expect(session.attachment.state).toBe("error");
    expect(host.liveSession(session.id)).toBe(session);
  });

  it.each(["regular", "assistant", "child", "workflow"] as const)("does not reuse a released %s attachment with queued work", async kind => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const parent = await engineHost.sessionFor(`release-parent-${kind}`, meta);
    await parent.pause();
    const resolve = () => {
      switch (kind) {
        case "regular": return engineHost.sessionFor("release-regular", meta);
        case "assistant": return defaultAssistantSessionFor(api!.providers, { type: "user", id: "local-user" },
          { actorUserId: "local-user", orgId: "local-org" });
        case "child": return engineHost.childSessionFor("release-child", { parentSessionId: parent.id,
          parentThreadId: parent.thread().id, actorUserId: "local-user", orgId: "local-org",
          owner: { type: "user", id: "local-user" }, workspace: "/tmp" });
        case "workflow": return engineHost.workflowSessionFor("release-workflow", { actorUserId: "local-user",
          orgId: "local-org", owner: { type: "user", id: "local-user" }, workspace: "/tmp" });
      }
    };
    const original = await resolve();
    await original.thread().pause();
    const receipt = await original.prompt("queued across release");
    await original.attachment.ensureReady({ timeoutMs: 5000 });
    await original.attachment.destroy("child_retention");
    expect(engineHost.liveSession(original.id)).toBe(original);
    const replacement = await resolve();
    expect(replacement).not.toBe(original);
    await expect(replacement.attachment.ensureReady({ timeoutMs: 5000 })).resolves.toBeDefined();
    expect(await engineStore.getQueueItem(original.id, receipt.queueItemId)).toMatchObject({ id: receipt.queueItemId, content: "queued across release" });
    expect(await resolve()).toBe(replacement);
  });

  it("retries admission if reclaim evicts the session after resolution", async () => {
    api = await bootTestApi();
    const { engineHost } = api.providers;
    const meta = { userId: "local-user", orgId: "local-org", workspace: "/tmp" };
    const original = await engineHost.sessionFor("reclaim-admission-gap", meta);
    await original.pause();
    let resolved!: () => void;
    const resolution = new Promise<void>(resolve => { resolved = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const resolveSession = engineHost.sessionFor.bind(engineHost);
    const resolving = vi.spyOn(engineHost, "sessionFor").mockImplementationOnce(async (id, options) => {
      const session = await resolveSession(id, options);
      resolved();
      await held;
      return session;
    });
    const admit = vi.fn(async (session: typeof original) => {
      await session.pause();
      return session.prompt("admit on the replacement");
    });
    const sending = engineHost.withSessionFor(original.id, meta, admit);
    try {
      await resolution;
      await engineHost.withSandboxCleanup(original.id, async () => {
        await original.attachment.destroy("child_retention");
        engineHost.evictCache(original.id, original);
      });
      release();
      const sent = await sending;
      const replacement = engineHost.liveSession(original.id);
      expect(replacement).not.toBe(original);
      expect(replacement).not.toBeNull();
      expect(admit).toHaveBeenCalledExactlyOnceWith(replacement);
      expect(await api.providers.engineStore.getQueueItem(original.id, sent.queueItemId)).toMatchObject({ status: "queued" });
    } finally { release(); await sending; resolving.mockRestore(); }
  });

  it("drops the cache but keeps every durable engine row", async () => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    const thread = session.thread("signal:evict-test");
    const receipt = await thread.submitPrompt("durable across shutdown?", {
      dispatchId: "evict-test:d-1",
    });

    expect(engineHost.isLive(session.id)).toBe(true);

    engineHost.evictAll();

    // Cache dropped…
    expect(engineHost.isLive(session.id)).toBe(false);
    // …but the durable rows survive: the session and its queued submission
    // are still in the store for boot-time reconciliation to resume.
    const stored = await engineStore.getSession(session.id);
    expect(stored).not.toBeNull();
    const item = await engineStore.getQueueItem(session.id, receipt.queueItemId);
    expect(item).not.toBeNull();
    expect(item?.status).not.toBe("settled");
  });
});
