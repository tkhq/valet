/** Unit coverage for the bus-event → span mapping (`spansForBusEvent`).
 * The SDK/exporter shell is env-gated glue; the mapping is the logic. */
import { describe, it, expect } from "vitest";
import type { DeliveredBusEvent, EngineEvent } from "@valet/engine";
import { spansForBusEvent } from "./otel.js";

function bus(event: EngineEvent, overrides: Partial<DeliveredBusEvent> = {}): DeliveredBusEvent {
  return {
    sessionId: "s1",
    threadId: "th1",
    queueItemId: "q1",
    event,
    timestamp: 1_000_000,
    ...overrides,
  };
}

describe("spansForBusEvent", () => {
  it("turn_end maps to agent.turn with derived start time and gen_ai usage/cost attrs", () => {
    const [span] = spansForBusEvent(
      bus({
        type: "turn_end",
        threadId: "th1",
        reason: "end_turn",
        model: "claude-haiku-4-5",
        usage: { input: 100, output: 20, cacheRead: 500, cacheWrite: 5, total: 625 },
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0032 },
        turnDurationMs: 4200,
      }),
    );
    expect(span.name).toBe("agent.turn");
    expect(span.startTime).toBe(1_000_000 - 4200);
    expect(span.endTime).toBe(1_000_000);
    expect(span.error).toBe(false);
    expect(span.attributes).toMatchObject({
      "valet.session.id": "s1",
      "valet.thread.id": "th1",
      "valet.queue_item.id": "q1",
      "valet.turn.reason": "end_turn",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "valet.usage.total_tokens": 625,
      "valet.cost.total_usd": 0.0032,
    });
  });

  it("turn_end without usage/cost/duration is an instant span with no gen_ai attrs", () => {
    const [span] = spansForBusEvent(bus({ type: "turn_end", threadId: "th1", reason: "abort" }));
    expect(span.startTime).toBe(span.endTime);
    expect(Object.keys(span.attributes)).not.toContain("gen_ai.usage.input_tokens");
    expect(Object.keys(span.attributes)).not.toContain("valet.cost.total_usd");
  });

  it("turn_end with reason=error carries error status", () => {
    const [span] = spansForBusEvent(bus({ type: "turn_end", threadId: "th1", reason: "error" }));
    expect(span.error).toBe(true);
  });

  it("submission_settled maps outcome + settle-patch record", () => {
    const [span] = spansForBusEvent(
      bus({
        type: "submission_settled",
        sessionId: "s1",
        threadId: "th1",
        queueItemId: "q1",
        outcome: { outcome: "completed" },
        patch: { status: "captured", blobKey: "patches/s1/q1.diff", bytes: 512 },
      }),
    );
    expect(span.name).toBe("submission.settled");
    expect(span.error).toBe(false);
    expect(span.attributes).toMatchObject({
      "valet.submission.outcome": "completed",
      "valet.patch.status": "captured",
      "valet.patch.blob_key": "patches/s1/q1.diff",
      "valet.patch.bytes": 512,
    });
  });

  it("failed settlement is an error span; skip reason is carried", () => {
    const [span] = spansForBusEvent(
      bus({
        type: "submission_settled",
        sessionId: "s1",
        threadId: "th1",
        queueItemId: "q1",
        outcome: { outcome: "failed", error: "credit balance too low" },
        patch: { status: "skipped", reason: "no_start_ref" },
      }),
    );
    expect(span.error).toBe(true);
    expect(span.attributes).toMatchObject({
      "valet.submission.error": "credit balance too low",
      "valet.patch.reason": "no_start_ref",
    });
  });

  it("engine error events map to error spans", () => {
    const [span] = spansForBusEvent(
      bus({ type: "error", threadId: "th1", code: "run_failed", error: "boom", recoverable: false }),
    );
    expect(span.name).toBe("engine.error");
    expect(span.error).toBe(true);
    expect(span.attributes).toMatchObject({ "valet.error.code": "run_failed" });
  });

  it("sandbox_status maps state + epoch; error state marks the span", () => {
    const [ready] = spansForBusEvent(
      bus({ type: "sandbox_status", sandboxId: "sb1", state: "ready", epoch: 2 }),
    );
    expect(ready.name).toBe("sandbox.status");
    expect(ready.error).toBe(false);
    expect(ready.attributes).toMatchObject({ "valet.sandbox.state": "ready", "valet.sandbox.epoch": 2 });
    const [errored] = spansForBusEvent(bus({ type: "sandbox_status", state: "error", epoch: 3 }));
    expect(errored.error).toBe(true);
  });

  it("high-frequency stream events map to nothing", () => {
    expect(spansForBusEvent(bus({ type: "text_delta", threadId: "th1", text: "x" }))).toEqual([]);
    expect(
      spansForBusEvent(bus({ type: "status", threadId: "th1", status: "thinking" })),
    ).toEqual([]);
  });
});
