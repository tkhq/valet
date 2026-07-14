/**
 * `createDebouncer` — the pure trailing-edge debouncer backing
 * `useInvalidateMessagesOnQueueState` (Task 5, CRITICAL flag: signal
 * entries only reach the client via REST, so the chat page needs a
 * debounced refetch cue from live `queue.state` frames). Tested directly
 * with fake timers, no React involved.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDebouncer } from "./debounce";

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not call fn before the delay elapses", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 500);
    d.trigger();
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn once the delay elapses", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 500);
    d.trigger();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of triggers into a single call", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 500);
    d.trigger();
    vi.advanceTimersByTime(200);
    d.trigger();
    vi.advanceTimersByTime(200);
    d.trigger();
    vi.advanceTimersByTime(200);
    // Only 200ms have elapsed since the last trigger — still pending.
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires again for a later, separate burst", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 500);
    d.trigger();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);

    d.trigger();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() prevents a pending call", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 500);
    d.trigger();
    vi.advanceTimersByTime(300);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
