import { expect, it, vi } from "vitest";

// Vite externalizes Node crypto and does not provide createHash in the browser.
vi.mock("node:crypto", () => ({}));
import { projectTurnProgress } from "../src/turn-progress.js";

it("projects a bounded deterministic revision without Node crypto", () => {
  const item = { id: "turn", threadId: "thread", content: "Work", status: "running" as const, attemptCount: 1, maxAttempts: 10, timeoutAt: 0, createdAt: 1, updatedAt: 2 };
  const first = projectTurnProgress(item, [], []);
  expect(first?.revision).toBeTypeOf("string");
  expect(first?.revision.length).toBeLessThanOrEqual(32);
  expect(projectTurnProgress(item, [], [])?.revision).toBe(first?.revision);
  expect(projectTurnProgress({ ...item, updatedAt: 3 }, [], [])?.revision).not.toBe(first?.revision);
});
