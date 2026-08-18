/**
 * `toRunCheckpoint` lifts the dispatch receipt's thread id onto the wire.
 *
 * A `session` or `orchestrator` node records `effects.receipt = { threadId,
 * queueItemId }` (`workflow/src/nodes/submission-node.ts`). The mapper used
 * to read `effects.sessionId` and `effects.childRunId` and drop the receipt,
 * so a run could name the session it woke but never the thread inside it.
 * For the caller's own assistant that session id redirects to /chat, which
 * then opens whichever thread is newest — so the run linked to the wrong
 * conversation, and looked like it had linked correctly.
 *
 * `effects` is stored JSON, so the malformed shapes below are reachable
 * rather than hypothetical.
 */
import { describe, expect, it } from "vitest";
import type { NodeCheckpoint } from "@valet/workflow";
import { toRunCheckpoint } from "./service.js";

function checkpoint(effects: Record<string, unknown> | undefined): NodeCheckpoint {
  return {
    runId: "wfrun_1",
    nodeId: "report",
    iteration: 0,
    attempt: 1,
    status: "completed",
    createdAt: 1,
    ...(effects !== undefined ? { effects } : {}),
  };
}

describe("toRunCheckpoint — thread id", () => {
  it("lifts the receipt's threadId beside the sessionId", () => {
    const wire = toRunCheckpoint(
      checkpoint({
        sessionId: "assistant:asst_1",
        receipt: { threadId: "thr_run_1", queueItemId: "q_1" },
        repairAttempted: false,
      }),
    );
    expect(wire.sessionId).toBe("assistant:asst_1");
    expect(wire.threadId).toBe("thr_run_1");
  });

  it("omits it for a node that dispatched nothing", () => {
    expect(toRunCheckpoint(checkpoint(undefined)).threadId).toBeUndefined();
    expect(toRunCheckpoint(checkpoint({})).threadId).toBeUndefined();
  });

  it("omits it rather than trusting a malformed receipt", () => {
    // Every hop is checked: `effects` is stored JSON, so a receipt that is
    // a string, or one whose threadId is not, must not reach the wire as a
    // link the client then builds a route from.
    expect(toRunCheckpoint(checkpoint({ receipt: "thr_1" })).threadId).toBeUndefined();
    expect(toRunCheckpoint(checkpoint({ receipt: null })).threadId).toBeUndefined();
    expect(toRunCheckpoint(checkpoint({ receipt: { threadId: 7 } })).threadId).toBeUndefined();
    expect(toRunCheckpoint(checkpoint({ receipt: {} })).threadId).toBeUndefined();
  });

  it("keeps childRunId independent of the receipt", () => {
    const wire = toRunCheckpoint(checkpoint({ childRunId: "wfrun_child" }));
    expect(wire.childRunId).toBe("wfrun_child");
    expect(wire.threadId).toBeUndefined();
  });
});
