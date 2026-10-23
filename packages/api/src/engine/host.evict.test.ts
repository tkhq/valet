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
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

describe("EngineHost.evictAll", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
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
    await original.pause();
    const receipt = await original.prompt("queued across release");
    await original.attachment.ensureReady({ timeoutMs: 5000 });
    await original.attachment.destroy("child_retention");
    expect(engineHost.liveSession(original.id)).toBeNull();
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
