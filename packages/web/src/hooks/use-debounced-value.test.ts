// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 250));
    expect(result.current).toBe("a");
  });

  it("only updates after the delay settles", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("a"); // not yet

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("ab");
  });

  it("resets the timer on rapid successive changes (only the last value lands)", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("a"); // still debouncing — 200 < 250 since last change

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe("abc");
  });
});
