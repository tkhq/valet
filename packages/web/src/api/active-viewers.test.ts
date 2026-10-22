// @vitest-environment jsdom
import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTyping, useAnnounceThreadView, useSessionWebSocket } from "./ws";
import { useActiveViewers, useActiveViewersStore } from "./active-viewers";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  useActiveViewersStore.setState({ bySession: {} });
});
afterEach(() => vi.unstubAllGlobals());

function renderView(sessionId: string, threadId: string) {
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return renderHook(({ thread }) => {
    useSessionWebSocket(sessionId);
    useAnnounceThreadView(sessionId, thread);
  }, { wrapper, initialProps: { thread: threadId } });
}

describe("thread viewers on the session socket", () => {
  it("reports the shown thread on connect and on every change", () => {
    const view = renderView("s1", "t1");
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    expect(socket?.sent.at(-1)).toEqual({ type: "viewing", threadIds: ["t1"], visible: true });
    view.rerender({ thread: "t2" });
    expect(socket?.sent.at(-1)).toEqual({ type: "viewing", threadIds: ["t2"], visible: true });
    view.unmount();
  });

  it("sends a typing signal at most every two seconds, and a stop once", () => {
    const view = renderView("s2", "t1");
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    const typing = () => socket?.sent.filter((frame) => (frame as { type: string }).type === "typing") ?? [];
    announceTyping("s2", "t1", true);
    announceTyping("s2", "t1", true);
    announceTyping("s2", "t1", false);
    announceTyping("s2", "t1", false);
    expect(typing()).toEqual([{ type: "typing", threadId: "t1", active: true }, { type: "typing", threadId: "t1", active: false }]);
    view.unmount();
  });

  it("stores viewer frames and leaves the reader out", () => {
    const view = renderView("s3", "t1");
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    act(() => socket?.onmessage?.({ data: JSON.stringify({ type: "thread.viewers", seq: 1, ts: 1, threadId: "t1", viewers: [
      { userId: "me", name: "Riley", typing: false }, { userId: "u2", name: "Dana Sales", typing: true },
    ] }) }));
    const { result } = renderHook(() => useActiveViewers("s3", "t1", "me"));
    expect(result.current.map((viewer) => viewer.name)).toEqual(["Dana Sales"]);
    view.unmount();
  });
});
