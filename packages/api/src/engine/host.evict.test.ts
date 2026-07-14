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

import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

describe("EngineHost.evictAll", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("drops the cache but keeps every durable engine row", async () => {
    api = await bootTestApi();
    const { engineHost, engineStore } = api.providers;

    const session = await engineHost.orchestratorSessionFor(
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
