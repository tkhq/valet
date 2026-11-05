// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileLayout } from "./use-mobile-layout";

afterEach(() => vi.unstubAllGlobals());

it("switches at 768px and follows viewport changes in both directions", () => {
  const changes = new EventTarget();
  const media = {
    matches: false,
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: vi.fn(changes.removeEventListener.bind(changes)),
  };
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("matchMedia", matchMedia);
  const { result, unmount } = renderHook(useMobileLayout);
  expect(matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  expect(result.current).toBe(false);
  act(() => { media.matches = true; changes.dispatchEvent(new Event("change")); });
  expect(result.current).toBe(true);
  act(() => { media.matches = false; changes.dispatchEvent(new Event("change")); });
  expect(result.current).toBe(false);
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
});

it("keeps the desktop layout when matchMedia is unavailable", () => {
  vi.stubGlobal("matchMedia", undefined);
  expect(renderHook(useMobileLayout).result.current).toBe(false);
});
