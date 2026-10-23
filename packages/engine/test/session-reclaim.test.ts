import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

function fixture() {
  const store = new InMemorySessionStore();
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const faux = registerFauxProvider({ provider: "reclaim-fence" });
  const create = () => engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel() });
  return { store, faux, create };
}

afterEach(() => vi.restoreAllMocks());

describe("session reclaim fence", () => {
  it.each(["followup", "collect", "inject", "steer"] as const)("queues %s admission without a claim until reclaim is cancelled", async queueMode => {
    const { store, faux, create } = fixture();
    let calls = 0;
    faux.setResponses([() => { calls++; return fauxAssistantMessage("done"); }]);
    const session = await create();
    try {
      expect(await session.beginReclaim()).toBe(true);
      const receipt = await session.prompt("wait for compute", { queueMode });
      await session.thread().kick();
      expect(await store.getQueueItem(session.id, receipt.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      expect(calls).toBe(0);
      session.cancelReclaim();
      expect((await session.thread().awaitResult(receipt.queueItemId)).outcome).toBe("completed");
      expect(calls).toBe(1);
    } finally { await session.destroy(); faux.unregister(); }
  });

  it("refuses reclaim while a store claim is in flight, before the local running item is installed", async () => {
    const { store, faux, create } = fixture();
    faux.setResponses([fauxAssistantMessage("done")]);
    const session = await create();
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const claim = store.claimSubmission.bind(store);
    vi.spyOn(store, "claimSubmission").mockImplementationOnce(async args => { entered(); await held; return claim(args); });
    try {
      const sent = await session.prompt("claim wins");
      await entering;
      expect(session.thread().hasActiveRun).toBe(false);
      expect(session.hasActiveExecution).toBe(true);
      expect(await session.beginReclaim()).toBe(false);
      expect(session.isReclaiming).toBe(false);
      release();
      expect((await session.thread().awaitResult(sent.queueItemId)).outcome).toBe("completed");
      expect((await store.getQueueItem(session.id, sent.queueItemId))?.attemptCount).toBe(1);
    } finally { release(); await session.destroy(); faux.unregister(); }
  });

  it("retains the fence after release and notifies recovery for admissions through old references", async () => {
    const { store, faux, create } = fixture();
    const session = await create();
    try {
      expect(await session.beginReclaim()).toBe(true);
      await session.attachment.destroy();
      const recover = vi.fn(async () => {});
      session.completeReclaim(recover);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
      const receipt = await session.prompt("late admission");
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
      expect(await store.getQueueItem(session.id, receipt.queueItemId)).toMatchObject({ status: "queued", attemptCount: 0 });
      expect(session.isReclaiming).toBe(true);
      expect(session.hasActiveExecution).toBe(false);
    } finally { await session.destroy(); faux.unregister(); }
  });
});
