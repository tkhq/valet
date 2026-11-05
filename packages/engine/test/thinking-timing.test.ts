import { describe, expect, it } from "vitest";
import { ThinkingTiming } from "../src/thinking-timing.js";

describe("ThinkingTiming", () => {
  it("measures separate blocks and freezes each at its own end", () => {
    const timing = new ThinkingTiming();
    timing.start(0, 1000);
    expect(timing.part(0)).toEqual({ type: "thinking", text: "", startedAt: 1000 });
    timing.end(0, 3400);
    timing.start(2, 9000);
    timing.end(2, 9500);
    expect(timing.part(0)).toEqual({ type: "thinking", text: "", startedAt: 1000, durationMs: 2400 });
    expect(timing.part(2).durationMs).toBe(500);
  });
  it("does not invent timing for missing start events", () => {
    const timing = new ThinkingTiming();
    timing.end(0, 2000);
    expect(timing.part(0)).toEqual({ type: "thinking", text: "" });
  });
  it("closes interrupted blocks without replacing completed durations", () => {
    const timing = new ThinkingTiming();
    timing.start(0, 1000);
    timing.end(0, 1200);
    timing.start(1, 1400);
    expect(timing.finish(2000)).toEqual([1]);
    expect(timing.finish(9000)).toEqual([]);
    expect(timing.part(0).durationMs).toBe(200);
    expect(timing.part(1).durationMs).toBe(600);
  });
});
