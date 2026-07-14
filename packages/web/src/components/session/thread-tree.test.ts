/**
 * Thread tree pure logic (decision 12): grouping children by the thread
 * that spawned them, and the status-dot class mapping. No DOM — the
 * component itself pulls from three live queries (orchestrator info,
 * threads, children) plus router search state, so these are extracted
 * precisely so they're testable without mounting all of that.
 */
import { describe, expect, it } from "vitest";
import type { OrchestratorChildSummary } from "@valet/api/wire";
import { childStatusDotClassName, groupChildrenByThread } from "./thread-tree";

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
