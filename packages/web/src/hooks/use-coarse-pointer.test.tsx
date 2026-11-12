// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { stubCoarsePointer } from "~/test/media-query";
import { useCoarsePointer } from "./use-coarse-pointer";

describe("useCoarsePointer", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is false where the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
  });

  it("starts from the current match", () => {
    stubCoarsePointer(true);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true);
  });

  it("follows the media query's change event", () => {
    const pointer = stubCoarsePointer(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
    act(() => pointer.setMatches(true));
    expect(result.current).toBe(true);
    act(() => pointer.setMatches(false));
    expect(result.current).toBe(false);
  });

  it("removes its change listener on unmount", () => {
    const pointer = stubCoarsePointer(false);
    const { unmount } = renderHook(() => useCoarsePointer());
    expect(pointer.listenerCount()).toBe(1);
    unmount();
    expect(pointer.listenerCount()).toBe(0);
  });
});
