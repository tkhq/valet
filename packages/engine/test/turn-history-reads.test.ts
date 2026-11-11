import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, FORK_SEED_APPLIED_KEY, FORK_SEED_PENDING_KEY, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  type MessageQuery,
} from "../src/index.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

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

// The store reads a long thread three ways. Postgres serves all three; this
// store adds the two payload-free ones so the test can tell them apart.
class ScopedReadStore extends InMemorySessionStore {
  outlineReads = 0;
  transcriptReads = 0;
  async getThreadOutline(sessionId: string, threadId: string) {
    this.outlineReads++;
    return InMemorySessionStore.prototype.getThreadSnapshot.call(this, sessionId, threadId);
  }
  async getTranscriptSnapshot(sessionId: string, threadId: string) {
    this.transcriptReads++;
    return InMemorySessionStore.prototype.getThreadSnapshot.call(this, sessionId, threadId);
  }
}

describe("compaction reads", () => {
  // On 2026-11-11 a compaction of a 10,000-entry channel thread held three
  // payload reads at once and ran the api out of heap.
  it("reads the full thread once and the live transcript after", async () => {
    const faux = registerFauxProvider({ provider: "compaction-reads" });
    const store = new ScopedReadStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const session = await new Engine({ providers }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = await session.ensureDefaultThread();
    const contexts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage(COMPLETE_SUMMARY),
      (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("third answer");
      },
    ]);
    try {
      for (const text of ["first question", "second question"]) {
        const receipt = await thread.submitPrompt(text, {});
        await thread.awaitResult(receipt.queueItemId);
      }
      const snapshots = vi.spyOn(store, "getThreadSnapshot");
      await thread.compactThread({ mode: "manual" });
      expect(snapshots.mock.calls.filter(([, id]) => id === thread.id)).toHaveLength(1);
      expect(store.outlineReads).toBe(1);
      expect(store.transcriptReads).toBe(1);
      snapshots.mockRestore();

      const entries = await store.getEntries(session.id, thread.id);
      expect(entries.some((e) => e.type === "compaction")).toBe(true);
      // The rebuilt transcript carries the summary in place of the head.
      const third = await thread.submitPrompt("third question", {});
      await thread.awaitResult(third.queueItemId);
      expect(contexts[0]).toContain("previous-context");
      expect(contexts[0]).not.toContain("first question");
      expect(contexts[0]).toContain("second question");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("estimates an idle thread's context from the transcript read", async () => {
    const faux = registerFauxProvider({ provider: "context-usage-reads" });
    const store = new ScopedReadStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const session = await new Engine({ providers }).createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    const thread = await session.ensureDefaultThread();
    faux.setResponses([fauxAssistantMessage("noted")]);
    try {
      const receipt = await thread.submitPrompt("remember the blue house", {});
      await thread.awaitResult(receipt.queueItemId);
      await vi.waitFor(() => expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(1));
      const snapshots = vi.spyOn(store, "getThreadSnapshot");
      const usage = await thread.contextUsage();
      expect(usage?.tokens).toBeGreaterThan(0);
      expect(store.transcriptReads).toBe(1);
      expect(snapshots.mock.calls.filter(([, id]) => id === thread.id)).toEqual([]);
      snapshots.mockRestore();
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
