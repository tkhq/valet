import { describe, expect, it, vi } from "vitest";
import { startSweepTimer } from "./sweep-timer.js";

describe("startSweepTimer (fix wave 2, M3)", () => {
  it("stop() waits for the pass in flight", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const order: string[] = [];
      const timer = startSweepTimer("test", 10, async () => {
        order.push("pass started");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        order.push("pass ended");
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(order).toEqual(["pass started"]);

      const stopped = timer.stop().then(() => order.push("stopped"));
      await Promise.resolve();
      expect(order).toEqual(["pass started"]);
      finish();
      await stopped;
      expect(order).toEqual(["pass started", "pass ended", "stopped"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() resolves at once with no pass in flight, and no pass runs after it", async () => {
    vi.useFakeTimers();
    try {
      const pass = vi.fn(async () => {});
      const timer = startSweepTimer("test", 10, pass);
      await timer.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(pass).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
