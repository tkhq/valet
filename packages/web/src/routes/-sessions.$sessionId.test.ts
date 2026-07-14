/**
 * Breadcrumb derivation (decision 8): a session opened at
 * `/sessions/$sessionId` shows a "spawned by {name} · back to chat"
 * breadcrumb iff its id appears in the assistant's children query.
 */
import { describe, expect, it } from "vitest";
import type { OrchestratorChildSummary } from "@valet/api/wire";
import { findChild } from "./sessions.$sessionId";

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

describe("findChild", () => {
  it("finds the child summary when the session id is a known child", () => {
    const children = [child({ sessionId: "child-1" }), child({ sessionId: "child-2" })];
    expect(findChild(children, "child-2")?.sessionId).toBe("child-2");
  });

  it("returns undefined for a standalone (non-child) session id", () => {
    const children = [child({ sessionId: "child-1" })];
    expect(findChild(children, "standalone-session")).toBeUndefined();
  });

  it("returns undefined for an empty children list", () => {
    expect(findChild([], "any")).toBeUndefined();
  });
});
