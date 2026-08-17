/**
 * Thread tree pure logic (decision 12): grouping children by the thread
 * that spawned them, and the status-dot class mapping. No DOM — the
 * component itself pulls from three live queries (orchestrator info,
 * threads, children) plus router search state, so these are extracted
 * precisely so they're testable without mounting all of that.
 */
import { describe, expect, it } from "vitest";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";
import {
  childStatusDotClassName,
  groupChildrenByThread,
  untitledThreadLabel,
} from "./thread-tree";

function child(overrides: Partial<OrchestratorChildSummary> = {}): OrchestratorChildSummary {
  return {
    sessionId: "child-1",
    title: "fix-auth",
    parentThreadId: "thread-1",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("groupChildrenByThread", () => {
  it("groups children under their parentThreadId", () => {
    const children = [
      child({ sessionId: "c1", parentThreadId: "thread-1" }),
      child({ sessionId: "c2", parentThreadId: "thread-1" }),
      child({ sessionId: "c3", parentThreadId: "thread-2" }),
    ];
    const grouped = groupChildrenByThread(children);
    expect(grouped.get("thread-1")?.map((c) => c.sessionId)).toEqual(["c1", "c2"]);
    expect(grouped.get("thread-2")?.map((c) => c.sessionId)).toEqual(["c3"]);
  });

  it("returns an empty map for no children", () => {
    expect(groupChildrenByThread([])).toEqual(new Map());
  });

  it("threads with no children simply have no entry", () => {
    const grouped = groupChildrenByThread([child({ parentThreadId: "thread-1" })]);
    expect(grouped.has("thread-2")).toBe(false);
  });
});

describe("childStatusDotClassName", () => {
  it("running gets the moss pulse class", () => {
    expect(childStatusDotClassName("running")).toContain("bg-moss");
    expect(childStatusDotClassName("running")).toContain("animate-pulse");
  });

  it("settled gets the muted class, no pulse", () => {
    const cls = childStatusDotClassName("settled");
    expect(cls).toContain("bg-muted");
    expect(cls).not.toContain("animate-pulse");
  });
});

/**
 * The fallback label used to be `Thread ${index + 1}`. Threads sort newest
 * first, so creating one renumbered every row below it — a number that
 * claims an identity and then hands it to a different thread. At two
 * threads nobody notices; at thirty the whole list shifts.
 */
describe("untitledThreadLabel", () => {
  const t = (id: string, createdAt: number): ThreadSummary => ({
    id,
    sessionId: "s1",
    createdAt,
    key: "web:1",
  });

  it("names the newest thread for what it is", () => {
    expect(untitledThreadLabel(t("a", 1_000), 0)).toBe("New thread");
  });

  it("gives an older thread a label that does not change when a new one arrives", () => {
    const older = t("b", 1_700_000_000_000);
    // Same thread, two different positions after another thread is created.
    expect(untitledThreadLabel(older, 3)).toBe(untitledThreadLabel(older, 7));
  });

  it("distinguishes two untitled threads created at different times", () => {
    const a = t("a", 1_700_000_000_000);
    const b = t("b", 1_700_086_400_000);
    expect(untitledThreadLabel(a, 2)).not.toBe(untitledThreadLabel(b, 3));
  });
});
