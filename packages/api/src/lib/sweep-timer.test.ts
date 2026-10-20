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

    it("still runs one more pass when runNow lands as a pass is settling", async () => {
      // Each delay puts the runNow call at a different microtask after the
      // pass resolves, so one of them lands between the end of the pass
      // and the moment the timer clears its in-flight mark.
      for (let delay = 0; delay < 8; delay++) {
        let calls = 0;
        let timer: ReturnType<typeof startSweepTimer> | undefined;
        timer = startSweepTimer("test", 60_000, async () => {
          calls++;
          if (calls === 1) {
            void (async () => {
              for (let i = 0; i < delay; i++) await null;
              timer?.runNow();
            })();
          }
        });
        timer.runNow();
        await vi.waitFor(() => expect(calls).toBe(2));
        await timer.stop();
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

  describe("runLight (event wakeups final review, item 5)", () => {
    it("runs the light pass, not the full pass", async () => {
      vi.useFakeTimers();
      try {
        const pass = vi.fn(async () => {});
        const light = vi.fn(async () => {});
        const timer = startSweepTimer("test", 60_000, pass, { light });
        timer.runLight();
        await vi.advanceTimersByTimeAsync(0);
        expect(light).toHaveBeenCalledTimes(1);
        expect(pass).not.toHaveBeenCalled();
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never overlaps a full pass and runs one light pass after it", async () => {
      vi.useFakeTimers();
      try {
        const releases: Array<() => void> = [];
        let running = 0;
        let maxRunning = 0;
        const tracked = (fn: () => Promise<void>) => async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await fn();
          running--;
        };
        const pass = vi.fn(tracked(() => new Promise<void>((resolve) => releases.push(resolve))));
        const light = vi.fn(tracked(async () => {}));
        const timer = startSweepTimer("test", 60_000, pass, { light });
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        timer.runLight();
        timer.runLight();
        await vi.advanceTimersByTimeAsync(0);
        expect(light).not.toHaveBeenCalled();
        releases.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(light).toHaveBeenCalledTimes(1);
        expect(pass).toHaveBeenCalledTimes(1);
        expect(maxRunning).toBe(1);
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs only the full pass when both are scheduled during a pass", async () => {
      vi.useFakeTimers();
      try {
        const releases: Array<() => void> = [];
        const pass = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
        const light = vi.fn(async () => {});
        const timer = startSweepTimer("test", 60_000, pass, { light });
        timer.runNow();
        await vi.advanceTimersByTimeAsync(0);
        timer.runLight();
        timer.runNow();
        releases.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(2);
        releases.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(light).not.toHaveBeenCalled();
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the full pass with no light pass configured", async () => {
      vi.useFakeTimers();
      try {
        const pass = vi.fn(async () => {});
        const timer = startSweepTimer("test", 60_000, pass);
        timer.runLight();
        await vi.advanceTimersByTimeAsync(0);
        expect(pass).toHaveBeenCalledTimes(1);
        await timer.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
