/**
 * Pure parts of the human surface over background work (fix wave 4,
 * group C): the refusal text and the work selection.
 */
import type { Lease, Wakeup } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { backgroundWorkRefusal, selectWork, type BlockingWork } from "./wakeups-admin.js";

const NOW = 1_800_000_000_000;

function process(id: string, status: Wakeup["status"], threadId = "th-1"): Wakeup {
  return {
    id,
    sessionId: "s-1",
    threadId,
    kind: "process",
    status,
    reason: `build ${id}`,
    command: "make",
    deadlineAt: NOW + 3_600_000,
    logOffset: 0,
    logTail: "",
    eventCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function hold(id: string, threadId?: string): Lease {
  return {
    id,
    sessionId: "s-1",
    ownerKind: "hold",
    ...(threadId !== undefined ? { threadId } : {}),
    reason: `hold ${id}`,
    createdAt: NOW,
    deadlineAt: NOW + 3_600_000,
  };
}

describe("backgroundWorkRefusal", () => {
  const work: BlockingWork = {
    id: "wk_1",
    kind: "process",
    status: "running",
    reason: "proof build",
    threadId: "th-1",
    deadlineAt: NOW,
    createdAt: NOW,
  };

  it("tells a member who may not stop the work to ask the agent or a team admin (archive)", () => {
    const text = backgroundWorkRefusal("archive", [work], 0, false);
    expect(text).toContain("Ask the agent in this thread to cancel it (wakeup_cancel), or ask a team admin.");
    expect(text).not.toContain("session admin");
  });

  it("names the same path for a session-wide action", () => {
    const text = backgroundWorkRefusal("pause", [work], 0, false);
    expect(text).toContain("Ask the agent to cancel it (wakeup_cancel), or ask a team admin, then pause the session.");
  });
});

describe("selectWork", () => {
  it("ships pending for a process that is still starting, and running for a hold", () => {
    const picked = selectWork(
      { wakeups: [process("wk_a", "pending"), process("wk_b", "running")], leases: [hold("ls_h", "th-1")] },
      {},
    );
    expect(picked.map((w) => [w.id, w.status])).toEqual([
      ["wk_a", "pending"],
      ["wk_b", "running"],
      ["ls_h", "running"],
    ]);
  });

  it("leaves a hold with no thread out of a thread filter, and keeps it session-wide", () => {
    const work = { wakeups: [], leases: [hold("ls_none")] };
    expect(selectWork(work, { threadId: "th-1" })).toEqual([]);
    expect(selectWork(work, { leasedOnly: true }).map((w) => w.id)).toEqual(["ls_none"]);
  });
});
