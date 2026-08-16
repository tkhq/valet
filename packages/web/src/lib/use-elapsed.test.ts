// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { formatElapsed, useElapsedSeconds } from "./use-elapsed";

describe("formatElapsed", () => {
  it("renders under a minute as plain seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
  });

  it("renders a minute or more as Nm SSs", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(125)).toBe("2m 05s");
  });
});

describe("useElapsedSeconds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns undefined when there's no start time", () => {
    const { result } = renderHook(() => useElapsedSeconds(undefined));
    expect(result.current).toBeUndefined();
  });

  it("counts up once a second from the start time", () => {
    const start = Date.now();
    const { result } = renderHook(() => useElapsedSeconds(start));
    expect(result.current).toBe(0);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(1);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(3);
  });

  it("restarts the count when the start time changes", () => {
    const start = Date.now();
    const { result, rerender } = renderHook(({ s }) => useElapsedSeconds(s), {
      initialProps: { s: start as number | undefined },
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(5);

    const newStart = Date.now();
    rerender({ s: newStart });
    expect(result.current).toBe(0);
  });

  it("stops ticking (returns undefined) once the start time clears", () => {
    const start = Date.now();
    const { result, rerender } = renderHook(({ s }) => useElapsedSeconds(s), {
      initialProps: { s: start as number | undefined },
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(2);

    rerender({ s: undefined });
    expect(result.current).toBeUndefined();
  });
});
