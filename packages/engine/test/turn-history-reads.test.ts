import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, FORK_SEED_APPLIED_KEY, FORK_SEED_PENDING_KEY, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  type MessageQuery,
} from "../src/index.js";

// A whole-thread read on every turn ran the api out of memory on 2026-10-28:
// the largest threads hold hundreds of MB of payloads. A turn reads by queue
// item, tail, head, or through the stubbed transcript snapshot.
function wholeThreadReads(
  entries: ReturnType<typeof vi.spyOn<InMemorySessionStore, "getEntries">>,
  snapshots: ReturnType<typeof vi.spyOn<InMemorySessionStore, "getThreadSnapshot">>,
  threadId: string,
): unknown[] {
  const unscoped = (opts: MessageQuery | undefined) => opts?.queueItemId === undefined && opts?.limit === undefined
    && opts?.headLimit === undefined && opts?.entryIds === undefined;
  return [
    ...entries.mock.calls.filter(([, id, opts]) => id === threadId && unscoped(opts)).map((call) => ["getEntries", ...call]),
    ...snapshots.mock.calls.filter(([, id]) => id === threadId).map((call) => ["getThreadSnapshot", ...call]),
  ];
}

async function setup(name: string) {
  const faux = registerFauxProvider({ provider: name });
  const store = new InMemorySessionStore();
  const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const session = await new Engine({ providers }).createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
  return { faux, store, session };
}

describe("turn history reads", () => {
  it("runs turns on a thread that was never forked without a whole-thread read", async () => {
    const { faux, store, session } = await setup("turn-reads-plain");
    const thread = await session.ensureDefaultThread();
    const entries = vi.spyOn(store, "getEntries");
    const snapshots = vi.spyOn(store, "getThreadSnapshot");
    try {
      for (const text of ["first", "second", "third"]) {
        const receipt = await thread.submitPrompt(text, {});
        await thread.awaitResult(receipt.queueItemId);
      }
      expect(wholeThreadReads(entries, snapshots, thread.id)).toEqual([]);
    } finally {
      session.suspendTimers();
      entries.mockRestore();
      snapshots.mockRestore();
      faux.unregister();
    }
  });

  it("checks a fork for pending files once, then stops reading", async () => {
    const { faux, store, session } = await setup("turn-reads-fork");
    const thread = await session.ensureDefaultThread();
    await thread.setMetadataValue(FORK_SEED_PENDING_KEY, true);
    const snapshots = vi.spyOn(store, "getThreadSnapshot");
    try {
      const first = await thread.submitPrompt("first", {});
      await thread.awaitResult(first.queueItemId);
      const afterFirst = snapshots.mock.calls.filter(([, id]) => id === thread.id).length;
      expect(afterFirst).toBeGreaterThan(0);
      expect((await store.getThread(session.id, thread.id))?.metadata).toMatchObject({ [FORK_SEED_APPLIED_KEY]: true, [FORK_SEED_PENDING_KEY]: false });
      const second = await thread.submitPrompt("second", {});
      await thread.awaitResult(second.queueItemId);
      expect(snapshots.mock.calls.filter(([, id]) => id === thread.id)).toHaveLength(afterFirst);
    } finally {
      session.suspendTimers();
      snapshots.mockRestore();
      faux.unregister();
    }
  });
});
