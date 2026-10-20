// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { useWebPresence } from "./web-presence";

vi.mock("./client", () => ({ api: { reportWebPresence: vi.fn(async () => ({ ok: true })) } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.mocked(api.reportWebPresence).mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => vi.useRealTimers());

describe("web presence heartbeat", () => {
  it("requires input, sends active heartbeats, then reports idle", () => {
    const hook = renderHook(() => useWebPresence());
    act(() => vi.advanceTimersByTime(20_000));
    expect(api.reportWebPresence).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event("keydown")));
    const tabId = vi.mocked(api.reportWebPresence).mock.calls[0]?.[0].tabId;
    expect(api.reportWebPresence).toHaveBeenLastCalledWith({ tabId, active: true });
    act(() => vi.advanceTimersByTime(20_000));
    expect(api.reportWebPresence).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(100_000));
    expect(api.reportWebPresence).toHaveBeenLastCalledWith({ tabId, active: false });
    act(() => vi.advanceTimersByTime(20_000));
    expect(api.reportWebPresence).toHaveBeenCalledTimes(7);
    hook.unmount();
  });

  it("reports hidden immediately and uses a separate id for each tab", () => {
    const one = renderHook(() => useWebPresence());
    const two = renderHook(() => useWebPresence());
    act(() => window.dispatchEvent(new Event("pointerdown")));
    const calls = vi.mocked(api.reportWebPresence).mock.calls;
    expect(calls[0]?.[0].tabId).not.toBe(calls[1]?.[0].tabId);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.mocked(api.reportWebPresence).mock.calls.slice(-2).every(([body]) => !body.active)).toBe(true);
    one.unmount();
    two.unmount();
    const count = vi.mocked(api.reportWebPresence).mock.calls.length;
    act(() => window.dispatchEvent(new Event("keydown")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(api.reportWebPresence).toHaveBeenCalledTimes(count);
  });
});
