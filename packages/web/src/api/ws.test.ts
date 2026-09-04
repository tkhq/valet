// @vitest-environment jsdom
/**
 * The socket lifecycle writes `conn` into the stream store, and readers
 * outside the session view now trust `conn === "open"` as "the store holds
 * live gate truth" (the assistant rail's needs-you dot). The case that
 * matters is unmount: `onclose` deliberately ignores a cancelled socket, so
 * the cleanup itself must mark the slice closed or it reads "open" forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionWebSocket } from "./ws";
import { useStreamStore } from "~/stores/stream";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code = 1000) {
    this.closed = true;
    // The real socket fires onclose asynchronously after close(); the
    // cancelled-flag path under test does not depend on it, so firing
    // synchronously here only makes the test stricter.
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  useStreamStore.setState({ bySession: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSessionWebSocket", () => {
  it("marks the slice open on connect and closed on unmount", () => {
    const { unmount } = renderHook(() => useSessionWebSocket("s1"));
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => socket?.onopen?.());
    expect(useStreamStore.getState().bySession["s1"]?.conn).toBe("open");

    unmount();
    // Cancelled sockets skip their onclose handler, so this is the cleanup's
    // own write — the slice must not stay "open" with nobody listening.
    expect(useStreamStore.getState().bySession["s1"]?.conn).toBe("closed");
  });

  it("backs off handshake failures until init confirms the connection", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionWebSocket("s1"));
    const first = FakeWebSocket.instances[0];

    act(() => {
      first?.onopen?.();
      first?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500);
    });
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();

    act(() => {
      second?.onopen?.();
      second?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => vi.advanceTimersByTime(1));
    const third = FakeWebSocket.instances[2];
    expect(third).toBeDefined();

    act(() => {
      third?.onopen?.();
      third?.onmessage?.({
        data: JSON.stringify({ type: "init", seq: 1, ts: 1, session: { id: "s1" } }),
      });
      third?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    unmount();
  });

  it("stops reconnecting when the session does not exist", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionWebSocket("missing"));
    const socket = FakeWebSocket.instances[0];

    act(() => socket?.onclose?.({ code: 4040 }));
    expect(useStreamStore.getState().bySession.missing?.conn).toBe("error");
    act(() => vi.advanceTimersByTime(8_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("retries application close codes that are not terminal for the session stream", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionWebSocket("s1"));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket?.onclose?.({ code: 4009 });
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });
});
