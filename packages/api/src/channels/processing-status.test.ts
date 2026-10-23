import { afterEach, expect, it, vi } from "vitest";
import { InMemoryEventStream, type DeliveredBusEvent } from "@valet/engine";
import { ChannelProcessingStatus } from "./processing-status.js";

afterEach(() => vi.useRealTimers());

function harness() {
  const statuses: string[] = [];
  const setStatus = vi.fn(async (_key: string, _ts: string, status: string) => { statuses.push(status); });
  const bus = new InMemoryEventStream();
  const status = new ChannelProcessingStatus(bus, () => ({ setStatus }));
  status.start();
  const begin = () => status.begin({ channelType: "slack", conversationKey: "slack:T:D:1", threadTs: "1", sessionId: "s", threadId: "t" });
  const emit = async (queueItemId: string, event: DeliveredBusEvent["event"] = { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId, outcome: { outcome: "completed" } }) => {
    await bus.append({ sessionId: "s", threadId: "t", queueItemId, timestamp: Date.now(), event }, `event:${Math.random()}`);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { status, statuses, setStatus, begin, emit };
}

it("shows processing, refreshes it, and clears only for the owning submission", async () => {
  vi.useFakeTimers();
  const h = harness();
  const turn = h.begin();
  h.status.bind(turn, "q1");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.statuses).toEqual(["is thinking…", "is thinking…"]);
  await h.emit("other");
  expect(h.statuses.at(-1)).toBe("is thinking…");
  await h.emit("q1");
  expect(h.statuses.at(-1)).toBe("");
  const callsAfterSettlement = h.setStatus.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.setStatus).toHaveBeenCalledTimes(callsAfterSettlement);
  await h.status.stop();
  expect(h.statuses.at(-1)).toBe("");
});

it("handles completion before the admission receipt arrives", async () => {
  const h = harness();
  const turn = h.begin();
  await h.emit("q1");
  h.status.bind(turn, "q1");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
  expect(h.statuses).toEqual(["is thinking…", ""]);
});

it("keeps a queued submission visible when the preceding turn finishes", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  h.status.bind(h.begin(), "q2");
  await h.emit("q1");
  await Promise.resolve();
  expect(h.statuses).not.toContain("");
  await h.emit("q2", { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q2", outcome: { outcome: "aborted" } });
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
  expect(h.statuses.at(-1)).toBe("");
});

it("serializes a slow thinking request before clearing rejected admission", async () => {
  const h = harness();
  let release = () => {};
  h.setStatus.mockImplementationOnce(async (_key, _ts, value) => {
    await new Promise<void>(resolve => { release = resolve; });
    h.statuses.push(value);
  });
  const turn = h.begin();
  await Promise.resolve();
  h.status.cancel(turn);
  release();
  await h.status.stop();
  expect(h.statuses).toEqual(["is thinking…", ""]);
});

it("contains provider failures and clears active status at shutdown", async () => {
  const h = harness();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  h.setStatus.mockRejectedValueOnce(new Error("missing_scope"));
  h.status.bind(h.begin(), "q1");
  await h.status.stop();
  expect(h.statuses.at(-1)).toBe("");
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

it.each(["completed", "aborted", "superseded"] as const)("clears a %s submission", async outcome => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q1", outcome: { outcome } });
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
  expect(h.statuses).toEqual(["is thinking…", ""]);
});

it("follows a merged submission until its answering submission settles", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q1", outcome: { outcome: "merged" }, mergedIntoItemId: "q2" });
  await Promise.resolve();
  expect(h.statuses).toEqual(["is thinking…"]);
  await h.emit("q2");
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
  expect(h.statuses.at(-1)).toBe("");
});

it("shows approval waits and resumes processing for the matching gate", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "decision_gate", threadId: "t", gate: {
    id: "g1", sessionId: "s", threadId: "t", queueItemId: "q1", resumeKey: "r1", ordinal: 0,
    type: "approval", title: "Approve", actions: [], status: "pending", createdAt: 0, updatedAt: 0,
  } });
  await h.emit("other", { type: "decision_gate_expired", threadId: "t", gateId: "other-gate" });
  await h.emit("q1", { type: "decision_gate_resolved", threadId: "t", gateId: "g1", resolution: { actionId: "approve", resolvedBy: "u1", resolvedAt: 1 } });
  await h.status.stop();
  expect(h.statuses).toEqual(["is thinking…", "is waiting for your approval…", "is thinking…", ""]);
});

it("clears failed submissions without relying on a message or turn end", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "submission_settled", sessionId: "s", threadId: "t", queueItemId: "q1", outcome: { outcome: "failed", error: "failed before model start" } });
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
  expect(h.statuses).toEqual(["is thinking…", ""]);
});

it("restores processing after a reply clears Slack status, but never after settlement", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  h.status.bind(h.begin(), "q2");
  await h.emit("q1");
  h.statuses.push(""); // Slack clears the indicator when the reply posts.
  h.status.refresh("s", "t");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.statuses.at(-1)).toBe("is thinking…");
  await h.emit("q2");
  const calls = h.setStatus.mock.calls.length;
  h.status.refresh("s", "t");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.setStatus).toHaveBeenCalledTimes(calls);
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
});

it("asks for a response on question gates", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "decision_gate", threadId: "t", gate: {
    id: "g1", sessionId: "s", threadId: "t", queueItemId: "q1", resumeKey: "r1", ordinal: 0,
    type: "question", title: "Which branch?", actions: [], status: "pending", createdAt: 0, updatedAt: 0,
  } });
  expect(h.statuses.at(-1)).toBe("is waiting for your response…");
  await h.status.stop();
});

it("keeps a pending gate visible when a followup queues on the same Slack thread", async () => {
  const h = harness();
  h.status.bind(h.begin(), "q1");
  await h.emit("q1", { type: "decision_gate", threadId: "t", gate: {
    id: "g1", sessionId: "s", threadId: "t", queueItemId: "q1", resumeKey: "r1", ordinal: 0,
    type: "approval", title: "Approve", actions: [], status: "pending", createdAt: 0, updatedAt: 0,
  } });
  const beforeFollowup = h.statuses.length;
  h.status.bind(h.begin(), "q2");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.statuses.slice(beforeFollowup)).toEqual(["is waiting for your approval…"]);
  await h.emit("q2");
  expect(h.statuses.at(-1)).toBe("is waiting for your approval…");
  await h.emit("q1");
  expect(h.statuses.at(-1)).toBe("");
  await h.status.stop();
});

it("rejects late registrations and binding after shutdown", async () => {
  const h = harness();
  const pending = h.begin();
  await h.status.stop();
  const calls = h.setStatus.mock.calls.length;
  expect(h.begin()).toBeUndefined();
  h.status.bind(pending, "late-receipt");
  h.status.refresh("s", "t");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.setStatus).toHaveBeenCalledTimes(calls);
  expect(h.statuses.at(-1)).toBe("");
  h.status.start();
  expect(h.begin()).toBeDefined();
  await h.status.stop();
});
