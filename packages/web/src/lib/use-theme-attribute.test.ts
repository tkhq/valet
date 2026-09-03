// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { useThemeAttribute } from "./use-theme-attribute";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("useThemeAttribute", () => {
  it("reads the current data-theme and null for system", () => {
    const { result } = renderHook(() => useThemeAttribute());
    expect(result.current).toBeNull();
  });

  it("tracks attribute changes", async () => {
    const { result } = renderHook(() => useThemeAttribute());
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      // MutationObserver delivers on a microtask.
      await Promise.resolve();
    });
    expect(result.current).toBe("dark");
  });
});
