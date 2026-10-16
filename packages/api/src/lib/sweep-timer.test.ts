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

  describe("runNow (event wakeups spec, Part E step 6)", () => {
    it("starts a pass at once when none is in flight", async () => {
      vi.useFakeTimers();
      try {
        const pass = vi.fn(async () => {});
        const timer = startSweepTimer("test", 60_000, pass);
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(1);
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never overlaps a running pass and runs exactly one more pass after it", async () => {
      vi.useFakeTimers();
      try {
        const releases: Array<() => void> = [];
        let running = 0;
        let maxRunning = 0;
        const pass = vi.fn(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise<void>((resolve) => releases.push(resolve));
          running--;
        });
        const timer = startSweepTimer("test", 60_000, pass);
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(1);
        // Three nudges during the pass coalesce into one follow-up pass.
        timer.runNow();
        timer.runNow();
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(1);
        releases.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(2);
        releases.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(2);
        expect(maxRunning).toBe(1);
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs nothing after stop()", async () => {
      vi.useFakeTimers();
      try {
        const pass = vi.fn(async () => {});
        const timer = startSweepTimer("test", 60_000, pass);
        await timer.stop();
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
