import { describe, it, expect } from "vitest";
import { shouldShortCircuit, deterministicGateId } from "../src/decision-gate.js";

const ctx = { sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "do:x" };
const ordinal = 0;
const gateId = deterministicGateId({ ...ctx, ordinal });
const resolution = { actionId: "approve", resolvedBy: "u", resolvedAt: 1 };

describe("shouldShortCircuit", () => {
  it("returns no match when no suspendedDecision", () => {
    expect(shouldShortCircuit({ ctx, suspendedDecision: undefined }).match).toBe(false);
  });

  it("returns no match when gateId differs", () => {
    expect(
      shouldShortCircuit({
        ctx,
        suspendedDecision: { gateId: "gate:other", ordinal, resolution },
      }).match,
    ).toBe(false);
  });

  it("returns no match when resolution is missing", () => {
    expect(shouldShortCircuit({ ctx, suspendedDecision: { gateId, ordinal } }).match).toBe(false);
  });

  it("returns match + resolution when gateId and resolution are present", () => {
    const result = shouldShortCircuit({
      ctx,
      suspendedDecision: { gateId, ordinal, resolution },
    });
    expect(result.match).toBe(true);
    if (result.match) expect(result.resolution).toEqual(resolution);
  });

  it("two ctx with same fields produce the same gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k", ordinal: 0 });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k", ordinal: 0 });
    expect(a).toBe(b);
  });

  it("differing resumeKey changes gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k1", ordinal: 0 });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k2", ordinal: 0 });
    expect(a).not.toBe(b);
  });

  it("does not match when suspended resumeKey is a colon-prefix of the current resumeKey", () => {
    // Suspended gate belongs to resumeKey "read:/x" (ordinal 0). The current
    // requestDecision call is for the colliding resumeKey "read:/x:confirm".
    // A prefix-based check on gateId would incorrectly match; exact-id
    // comparison must not.
    const suspendedCtx = { sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "read:/x" };
    const suspendedGateId = deterministicGateId({ ...suspendedCtx, ordinal: 0 });
    const collidingCtx = { sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "read:/x:confirm" };
    const result = shouldShortCircuit({
      ctx: collidingCtx,
      suspendedDecision: { gateId: suspendedGateId, ordinal: 0, resolution },
    });
    expect(result.match).toBe(false);
  });
});
