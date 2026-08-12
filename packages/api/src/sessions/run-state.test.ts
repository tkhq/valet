/**
 * Run-state derivation (`sessions/run-state.ts`) — the precedence order the
 * wire type pins: needs_you > working > failed > sleeping > idle. Pure
 * functions over a row and its unsettled submissions, so no database and no
 * engine turn is needed here; the routes that feed them real submissions are
 * covered by the sessions integration suites.
 */
import { describe, it, expect } from "vitest";
import type { QueueItem } from "@valet/engine";
import {
  deriveLastActivityAt,
  deriveRunFields,
  deriveRunState,
  groupSubmissionsBySession,
  type RunStateRow,
  type RunStateSubmission,
} from "./run-state.js";

function row(overrides: Partial<RunStateRow> = {}): RunStateRow {
  return { status: "active", updatedAt: 1_000, ...overrides };
}

function submission(
  status: QueueItem["status"],
  overrides: Partial<RunStateSubmission> = {},
): RunStateSubmission {
  return { status, updatedAt: 1_000, ...overrides };
}

describe("deriveRunState", () => {
  it("reads idle when nothing is queued", () => {
    expect(deriveRunState(row(), [])).toBe("idle");
  });

  it("reads sleeping for a hibernated row with no queued work", () => {
    expect(deriveRunState(row({ status: "hibernated" }), [])).toBe("sleeping");
  });

  it("reads working for a queued, collecting, or running submission", () => {
    expect(deriveRunState(row(), [submission("queued")])).toBe("working");
    expect(deriveRunState(row(), [submission("collecting")])).toBe("working");
    expect(deriveRunState(row(), [submission("running")])).toBe("working");
  });

  it("reads needs_you for a submission blocked on a decision gate", () => {
    expect(deriveRunState(row(), [submission("blocked_on_decision_gate")])).toBe("needs_you");
  });

  it("reads failed for a submission settling with a failed outcome", () => {
    const failing = submission("terminalizing", { outcome: { outcome: "failed", error: "boom" } });
    expect(deriveRunState(row(), [failing])).toBe("failed");
  });

  it("does not read failed for a submission settling successfully", () => {
    const done = submission("terminalizing", { outcome: { outcome: "completed" } });
    expect(deriveRunState(row(), [done])).toBe("idle");
  });

  it("prefers needs_you over working when both threads apply", () => {
    const both = [submission("running"), submission("blocked_on_decision_gate")];
    expect(deriveRunState(row(), both)).toBe("needs_you");
  });

  it("prefers working over failed when another turn is still in flight", () => {
    const both = [
      submission("terminalizing", { outcome: { outcome: "failed", error: "boom" } }),
      submission("queued"),
    ];
    expect(deriveRunState(row(), both)).toBe("working");
  });

  it("prefers queued work over sleeping — a woken session is working", () => {
    expect(deriveRunState(row({ status: "hibernated" }), [submission("queued")])).toBe("working");
  });
});

describe("deriveLastActivityAt", () => {
  it("returns the row timestamp when the session has no submissions", () => {
    expect(deriveLastActivityAt(row({ updatedAt: 500 }), [])).toBe(500);
  });

  it("returns the newest submission timestamp when a turn outran the row", () => {
    const items = [submission("running", { updatedAt: 2_500 }), submission("queued", { updatedAt: 1_800 })];
    expect(deriveLastActivityAt(row({ updatedAt: 500 }), items)).toBe(2_500);
  });

  it("keeps the row timestamp when it is the newer of the two", () => {
    expect(deriveLastActivityAt(row({ updatedAt: 9_000 }), [submission("queued", { updatedAt: 100 })])).toBe(
      9_000,
    );
  });
});

describe("deriveRunFields", () => {
  it("returns both derived fields from one call", () => {
    const fields = deriveRunFields(row({ updatedAt: 10 }), [submission("running", { updatedAt: 42 })]);
    expect(fields).toEqual({ runState: "working", lastActivityAt: 42 });
  });
});

describe("groupSubmissionsBySession", () => {
  it("indexes cross-session submissions by session id", () => {
    const all = [
      { ...submission("queued"), sessionId: "a" },
      { ...submission("running"), sessionId: "b" },
      { ...submission("blocked_on_decision_gate"), sessionId: "a" },
    ];
    const bySession = groupSubmissionsBySession(all);
    expect(bySession.get("a")).toHaveLength(2);
    expect(bySession.get("b")).toHaveLength(1);
    expect(bySession.get("missing")).toBeUndefined();
  });
});
