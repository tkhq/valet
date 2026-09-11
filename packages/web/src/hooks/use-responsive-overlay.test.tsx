// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResponsiveOverlay } from "./use-responsive-overlay";

afterEach(() => vi.unstubAllGlobals());

it("closes the overlay when desktop takes over and removes the listener on unmount", () => {
  const changes = new EventTarget();
  const media = {
    matches: false,
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: vi.fn(changes.removeEventListener.bind(changes)),
  };
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("matchMedia", matchMedia);
  const { result, unmount } = renderHook(() => useResponsiveOverlay("md"));
  expect(matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  act(() => result.current.setOpen(true));
  expect(result.current.open).toBe(true);
  act(() => {
    media.matches = true;
    changes.dispatchEvent(new Event("change"));
  });
  expect(result.current.open).toBe(false);
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
});
