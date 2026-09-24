// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi, useBrowserFrame } from "./browser";

const originalURL = URL;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("browser view lifecycle", () => {
  it("releases frames and stops requests while the page is hidden", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends originalURL {
        static createObjectURL = vi.fn(() => "blob:test");
        static revokeObjectURL = revoke;
      },
    );
    vi.spyOn(browserApi, "ticket").mockResolvedValue({
      ticket: "ticket",
      expiresAt: Date.now() + 300_000,
    });
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response("image", {
            headers: {
              "content-type": "image/jpeg",
              "x-browser-runtime-id": "runtime",
              "x-browser-document-id": "doc",
              "x-browser-viewport-width": "1280",
              "x-browser-viewport-height": "720",
            },
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() =>
      useBrowserFrame("session", "runtime", "tab", true),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.frame?.documentId).toBe("doc");
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const calls = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(view.result.current.frame).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:test");
    view.unmount();
  });
});
