import { afterEach, describe, expect, it, vi } from "vitest";
import { createWsConnectionLifecycle } from "./ws.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WebSocket connection lifecycle", () => {
  it("does not start a keepalive after the socket closes", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const lifecycle = createWsConnectionLifecycle();

    lifecycle.setUnsubscribe(unsubscribe);
    lifecycle.close();
    lifecycle.startKeepalive(vi.fn());

    expect(lifecycle.closed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an active keepalive when the socket closes", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const lifecycle = createWsConnectionLifecycle();

    lifecycle.setUnsubscribe(unsubscribe);
    lifecycle.startKeepalive(vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.close();

    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("unsubscribes immediately when subscription completes after close", () => {
    const unsubscribe = vi.fn();
    const lifecycle = createWsConnectionLifecycle();

    lifecycle.close();
    lifecycle.setUnsubscribe(unsubscribe);

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
