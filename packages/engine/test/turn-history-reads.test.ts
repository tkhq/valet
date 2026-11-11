import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, FORK_SEED_APPLIED_KEY, FORK_SEED_PENDING_KEY, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  estimateTotalTokens, walkTranscriptDag, type CompactionEntry, type MessageQuery, type SessionEntry,
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
  it("reads only the transcript, never the full thread", async () => {
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
      expect(snapshots.mock.calls.filter(([, id]) => id === thread.id)).toEqual([]);
      expect(store.outlineReads).toBe(1);
      expect(store.transcriptReads).toBe(2);
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

  // A second compaction gets the first checkpoint's entries as stubs, as
  // the Postgres store returns them. It must carry them forward by id and
  // measure, never re-read or overwrite them.
  it("carries covered history forward from the newest checkpoint", async () => {
    const faux = registerFauxProvider({ provider: "compaction-forward" });
    const store = new StubbingStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const session = await new Engine({ providers }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = await session.ensureDefaultThread();
    const contexts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/notes.md" }, { id: "read-notes" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage(COMPLETE_SUMMARY),
      fauxAssistantMessage("third answer"),
      fauxAssistantMessage(COMPLETE_SUMMARY),
      (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("fourth answer");
      },
    ]);
    const ask = async (text: string) => {
      const receipt = await thread.submitPrompt(text, {});
      await thread.awaitResult(receipt.queueItemId);
    };
    const checkpoints = async () => (await store.getEntries(session.id, thread.id))
      .filter((e): e is CompactionEntry => e.type === "compaction");
    try {
      await ask("first question");
      await ask("second question");
      await thread.compactThread({ mode: "manual" });
      const [first] = await checkpoints();
      expect(first?.fileContext?.read).toEqual(["/notes.md"]);

      await ask("third question");
      store.fullReads = 0;
      await thread.compactThread({ mode: "manual" });
      expect(store.fullReads).toBe(0);
      const [, second] = await checkpoints();
      if (!first || !second) throw new Error("Expected two checkpoints");

      const entries = await store.getEntries(session.id, thread.id);
      const userText = (text: string) => entries.find((e) => e.type === "message" && e.role === "user" && e.content === text);
      expect(second.coveredEntryIds).toEqual(expect.arrayContaining(first.coveredEntryIds));
      expect(second.coveredEntryIds).toContain(userText("second question")?.id);
      expect(second.coveredEntryIds).not.toContain(userText("third question")?.id);
      const firstCovered = new Set(first.coveredEntryIds);
      const newlyCovered = entries.filter((e) => second.coveredEntryIds.includes(e.id) && !firstCovered.has(e.id));
      expect(second.tokenCountBefore).toBe(first.tokenCountBefore + estimateTotalTokens(newlyCovered));
      expect(second.fileContext?.read).toEqual(["/notes.md"]);
      // The stubs the pass saw never replaced the stored payloads.
      expect(userText("first question")).toBeDefined();
      const readCall = entries.flatMap((e) => e.type === "message" ? e.parts ?? [] : [])
        .find((part) => part.type === "tool_call" && part.callId === "read-notes");
      expect(readCall?.type === "tool_call" ? readCall.args : undefined).toEqual({ path: "/notes.md" });

      await ask("fourth question");
      expect(contexts[0]).toContain("previous-context");
      expect(contexts[0]).not.toContain("first question");
      expect(contexts[0]).not.toContain("second question");
      expect(contexts[0]).toContain("third question");
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

// The `getTranscriptSnapshot` contract the Postgres store keeps: an entry the
// newest compaction on the active branch covers comes back as a stub, except
// the `keepQueueItemId` prompt.
class StubbingStore extends InMemorySessionStore {
  fullReads = 0;
  async getThreadSnapshot(sessionId: string, threadId: string) {
    this.fullReads++;
    return super.getThreadSnapshot(sessionId, threadId);
  }
  async getThreadOutline(sessionId: string, threadId: string) {
    return InMemorySessionStore.prototype.getThreadSnapshot.call(this, sessionId, threadId);
  }
  async getTranscriptSnapshot(sessionId: string, threadId: string, opts?: { keepQueueItemId?: string }) {
    const snapshot = await InMemorySessionStore.prototype.getThreadSnapshot.call(this, sessionId, threadId);
    if (!snapshot) return null;
    const path = walkTranscriptDag(snapshot.entries, snapshot.thread.activeLeafEntryId);
    const newest = path.filter((e): e is CompactionEntry => e.type === "compaction").at(-1);
    const covered = new Set(newest?.coveredEntryIds ?? []);
    const stub = (entry: SessionEntry): SessionEntry => {
      if (!covered.has(entry.id)) return entry;
      if (entry.type === "message") {
        if (opts?.keepQueueItemId !== undefined && entry.queueItemId === opts.keepQueueItemId) return entry;
        return { ...entry, content: "", parts: undefined, metadata: undefined, signal: undefined, author: undefined, channel: undefined };
      }
      if (entry.type === "compaction") return { ...entry, summary: "", coveredEntryIds: [], fileContext: undefined, metadata: undefined };
      return entry;
    };
    return { thread: snapshot.thread, entries: snapshot.entries.map(stub) };
  }
}
