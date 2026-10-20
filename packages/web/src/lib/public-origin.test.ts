// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { loadPublicOrigin, setPublicOrigin, usePublicOrigin } from "./public-origin";

describe("usePublicOrigin", () => {
  afterEach(() => setPublicOrigin(null));

  it("is null until the app entry sets it, then updates every reader", () => {
    const { result } = renderHook(() => usePublicOrigin());
    expect(result.current).toBeNull();
    act(() => setPublicOrigin("https://valet.example.com"));
    expect(result.current).toBe("https://valet.example.com");
  });

  it("retries a failed read, so a startup failure does not leave links on the public hostname", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ publicOrigin: "https://valet.example.com" });
      const { result } = renderHook(() => usePublicOrigin());
      const loading = loadPublicOrigin(read, [1_000]);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await loading; });
      expect(read).toHaveBeenCalledTimes(2);
      expect(result.current).toBe("https://valet.example.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after the last retry and leaves links unchanged", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const loading = loadPublicOrigin(read, [10, 20]);
      await vi.advanceTimersByTimeAsync(100);
      await loading;
      expect(read).toHaveBeenCalledTimes(3);
      expect(renderHook(() => usePublicOrigin()).result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
