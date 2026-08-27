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
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    // The real socket fires onclose asynchronously after close(); the
    // cancelled-flag path under test does not depend on it, so firing
    // synchronously here only makes the test stricter.
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  useStreamStore.setState({ bySession: {} });
});

afterEach(() => {
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
});
