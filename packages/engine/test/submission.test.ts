import { describe, it, expect } from "vitest";
import {
  deriveQueueState,
  originFromEntries,
  renderSignalEnvelope,
  resolvePartialSubmissionText,
  resolveSubmissionText,
} from "../src/submission.js";
import type { MessageEntry, QueueItem, SessionEntry, SubmissionStatus } from "../src/types.js";

const THREAD = "th-1";

function item(overrides: Partial<QueueItem> & { id: string; status: SubmissionStatus }): QueueItem {
  const createdAt = overrides.createdAt ?? 1_000;
  return {
    threadId: THREAD,
    content: `content-${overrides.id}`,
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: createdAt + 3_600_000,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("deriveQueueState (pure)", () => {
  it("empty items + not paused → idle", () => {
    const state = deriveQueueState(THREAD, [], "followup", false);
    expect(state).toEqual({
      threadId: THREAD,
      mode: "followup",
      status: "idle",
      activeItemId: undefined,
      pending: [],
      collectBuffer: undefined,
      blockedGateId: undefined,
    });
  });

  it("paused wins over everything (highest precedence)", () => {
    const items = [
      item({ id: "a", status: "blocked_on_decision_gate" }),
      item({ id: "b", status: "running", createdAt: 2_000 }),
      item({ id: "c", status: "queued", createdAt: 3_000 }),
    ];
    const state = deriveQueueState(THREAD, items, "followup", true, "gate-1");
    expect(state.status).toBe("paused");
    expect(state.blockedGateId).toBe("gate-1");
  });

  it("blocked_on_decision_gate wins over running and queued", () => {
    const items = [
      item({ id: "a", status: "blocked_on_decision_gate" }),
      item({ id: "b", status: "queued", createdAt: 2_000 }),
    ];
    const state = deriveQueueState(THREAD, items, "followup", false, "gate-2");
    expect(state.status).toBe("blocked_on_decision_gate");
    expect(state.activeItemId).toBe("a");
    expect(state.blockedGateId).toBe("gate-2");
  });

  it("running wins over queued", () => {
    const items = [
      item({ id: "a", status: "running" }),
      item({ id: "b", status: "queued", createdAt: 2_000 }),
    ];
    const state = deriveQueueState(THREAD, items, "followup", false);
    expect(state.status).toBe("running");
    expect(state.activeItemId).toBe("a");
  });

  it("queued items alone → queued; none → idle", () => {
    const queued = deriveQueueState(THREAD, [item({ id: "a", status: "queued" })], "followup", false);
    expect(queued.status).toBe("queued");
    const settledOnly = deriveQueueState(
      THREAD,
      [item({ id: "a", status: "settled" })],
      "followup",
      false,
    );
    expect(settledOnly.status).toBe("idle");
  });

  it("pending is queued items oldest-first, excluding superseded ones", () => {
    const items = [
      item({ id: "c", status: "queued", createdAt: 3_000 }),
      item({ id: "a", status: "queued", createdAt: 1_000 }),
      item({ id: "b", status: "queued", createdAt: 2_000, supersededByItemId: "c" }),
      item({ id: "d", status: "settled", createdAt: 500 }),
    ];
    const state = deriveQueueState(THREAD, items, "followup", false);
    expect(state.pending.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("collectBuffer contains collecting items; omitted when none", () => {
    const items = [
      item({ id: "a", status: "collecting", createdAt: 1_000 }),
      item({ id: "b", status: "collecting", createdAt: 2_000 }),
      item({ id: "c", status: "queued", createdAt: 3_000 }),
    ];
    const state = deriveQueueState(THREAD, items, "collect", false);
    expect(state.collectBuffer?.map((i) => i.id)).toEqual(["a", "b"]);
    const none = deriveQueueState(THREAD, [item({ id: "c", status: "queued" })], "collect", false);
    expect(none.collectBuffer).toBeUndefined();
  });

  it("activeItemId is the running or blocked item; undefined otherwise", () => {
    const blocked = deriveQueueState(
      THREAD,
      [item({ id: "a", status: "blocked_on_decision_gate" })],
      "followup",
      false,
    );
    expect(blocked.activeItemId).toBe("a");
    const queuedOnly = deriveQueueState(
      THREAD,
      [item({ id: "a", status: "queued" })],
      "followup",
      false,
    );
    expect(queuedOnly.activeItemId).toBeUndefined();
  });

  it("items from other threads are ignored", () => {
    const items = [
      item({ id: "a", status: "running" }),
      { ...item({ id: "x", status: "queued" }), threadId: "th-other" },
    ];
    const state = deriveQueueState(THREAD, items, "followup", false);
    expect(state.status).toBe("running");
    expect(state.pending).toEqual([]);
  });

  it("mode passes through", () => {
    expect(deriveQueueState(THREAD, [], "collect", false).mode).toBe("collect");
    expect(deriveQueueState(THREAD, [], "steer", false).mode).toBe("steer");
  });
});

let entrySeq = 1;
function assistantEntry(
  overrides: Partial<MessageEntry> & { content: string },
): MessageEntry {
  const n = entrySeq++;
  return {
    id: `e-${n}`,
    sessionId: "sess-1",
    threadId: THREAD,
    parentId: null,
    createdAt: 1_000 + n,
    type: "message",
    role: "assistant",
    ...overrides,
  };
}

describe("resolveSubmissionText / resolvePartialSubmissionText (pure)", () => {
  it("two end_turn assistant entries with the same queueItemId → the LAST one's content wins", () => {
    const entries: SessionEntry[] = [
      assistantEntry({ content: "first", queueItemId: "q-1", stopReason: "end_turn" }),
      assistantEntry({ content: "second", queueItemId: "q-1", stopReason: "end_turn" }),
    ];
    expect(resolveSubmissionText(entries, "q-1")).toBe("second");
    expect(resolvePartialSubmissionText(entries, "q-1")).toBe("second");
  });

  it("interleaved entries from other queueItemIds and other roles are ignored", () => {
    const entries: SessionEntry[] = [
      assistantEntry({ content: "mine", queueItemId: "q-1", stopReason: "end_turn" }),
      assistantEntry({ content: "other item", queueItemId: "q-2", stopReason: "end_turn" }),
      assistantEntry({ content: "user text", queueItemId: "q-1", stopReason: "end_turn", role: "user" }),
      {
        id: "e-comp",
        sessionId: "sess-1",
        threadId: THREAD,
        parentId: null,
        createdAt: 9_999,
        type: "compaction",
        summary: "compacted",
        coveredEntryIds: [],
        tokenCountBefore: 10,
        tokenCountAfter: 1,
        queueItemId: "q-1",
      },
    ];
    expect(resolveSubmissionText(entries, "q-1")).toBe("mine");
    expect(resolvePartialSubmissionText(entries, "q-1")).toBe("mine");
  });

  it("entries without end_turn are ignored by resolveSubmissionText but honored by resolvePartialSubmissionText", () => {
    const aborted: SessionEntry[] = [
      assistantEntry({ content: "partial", queueItemId: "q-1", stopReason: "abort" }),
    ];
    expect(resolveSubmissionText(aborted, "q-1")).toBeUndefined();
    expect(resolvePartialSubmissionText(aborted, "q-1")).toBe("partial");

    const missingStop: SessionEntry[] = [
      assistantEntry({ content: "no stop reason", queueItemId: "q-1" }),
    ];
    expect(resolveSubmissionText(missingStop, "q-1")).toBeUndefined();
    expect(resolvePartialSubmissionText(missingStop, "q-1")).toBe("no stop reason");

    // partial resolver still takes the LAST match, mixed stop reasons.
    const mixed: SessionEntry[] = [
      assistantEntry({ content: "finished", queueItemId: "q-1", stopReason: "end_turn" }),
      assistantEntry({ content: "later abort", queueItemId: "q-1", stopReason: "abort" }),
    ];
    expect(resolveSubmissionText(mixed, "q-1")).toBe("finished");
    expect(resolvePartialSubmissionText(mixed, "q-1")).toBe("later abort");
  });

  it("empty entries / no match returns undefined", () => {
    expect(resolveSubmissionText([], "q-1")).toBeUndefined();
    expect(resolvePartialSubmissionText([], "q-1")).toBeUndefined();
    const otherOnly: SessionEntry[] = [
      assistantEntry({ content: "other", queueItemId: "q-2", stopReason: "end_turn" }),
    ];
    expect(resolveSubmissionText(otherOnly, "q-1")).toBeUndefined();
    expect(resolvePartialSubmissionText(otherOnly, "q-1")).toBeUndefined();
  });
});

describe("renderSignalEnvelope with channel origin", () => {
  it("renders origin as the thread key attribute plus addressed, sorted with the rest", () => {
    const signal: NonNullable<MessageEntry["signal"]> = {
      signalType: "slack.app_mention",
      tagName: "signal",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2" },
    };
    // Default (no reply mode) is addressed — a mention answers directly.
    expect(renderSignalEnvelope(signal, "who are you")).toBe(
      `<signal signalType="slack.app_mention" addressed="true" origin="slack:C1:1.2">who are you</signal>`,
    );
  });

  it("renders addressed=\"false\" for an overheard (manual-reply) origin", () => {
    const signal: NonNullable<MessageEntry["signal"]> = {
      signalType: "slack.message",
      tagName: "signal",
      origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "manual" },
    };
    expect(renderSignalEnvelope(signal, "any update?")).toBe(
      `<signal signalType="slack.message" addressed="false" origin="slack:C1:1.2">any update?</signal>`,
    );
  });
});

describe("originFromEntries (pure)", () => {
  function userSignalEntry(queueItemId: string, threadKey: string): MessageEntry {
    return {
      id: `u-${queueItemId}`,
      sessionId: "sess-1",
      threadId: THREAD,
      parentId: null,
      createdAt: 1_000,
      type: "message",
      role: "user",
      content: "hi",
      queueItemId,
      signal: {
        signalType: "slack.app_mention",
        tagName: "signal",
        origin: { channelType: "slack", threadKey },
      },
    };
  }

  it("returns the signal entry's origin for a matching queueItemId", () => {
    const entries: SessionEntry[] = [
      userSignalEntry("q-1", "slack:C1:1.2"),
      assistantEntry({ content: "ack", queueItemId: "q-1", stopReason: "end_turn" }),
    ];
    expect(originFromEntries(entries, "q-1")).toEqual({ channelType: "slack", threadKey: "slack:C1:1.2" });
    expect(originFromEntries(entries, "q-2")).toBeUndefined();
  });

  it("returns undefined when the signal entry has no origin", () => {
    const entries: SessionEntry[] = [
      assistantEntry({ content: "user text", queueItemId: "q-1", role: "user" }),
      assistantEntry({ content: "ack", queueItemId: "q-1", stopReason: "end_turn" }),
    ];
    expect(originFromEntries(entries, "q-1")).toBeUndefined();
  });
});
