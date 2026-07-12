import { describe, it, expect } from "vitest";
import { deriveQueueState } from "../src/submission.js";
import type { QueueItem, SubmissionStatus } from "../src/types.js";

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
