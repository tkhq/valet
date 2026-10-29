// @vitest-environment jsdom
/**
 * The socket lifecycle writes `conn` into the stream store, and readers
 * outside the session view now trust `conn === "open"` as "the store holds
 * live gate truth" (the assistant rail's needs-you dot). The case that
 * matters is unmount: `onclose` deliberately ignores a cancelled socket, so
 * the cleanup itself must mark the slice closed or it reads "open" forever.
 */
import { createElement, type PropsWithChildren } from "react";
import type { ListThreadsResponse } from "@valet/api/wire";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";
import { useSidebarThreads } from "./queries";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionWebSocket } from "./ws";
import { useStreamStore } from "~/stores/stream";
import { reportServerReachable, reportServerUnavailable } from "./connection";

// The socket reports closes and reconnects to the app's connection state.
// The health probe behind it is tested in connection.test.ts.
vi.mock("./connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection")>()),
  reportServerReachable: vi.fn(),
  reportServerUnavailable: vi.fn(),
}));

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
  // No jitter, so the reconnect waits are exactly 500 ms, 1 s, 2 s.
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.mocked(reportServerReachable).mockClear();
  vi.mocked(reportServerUnavailable).mockClear();
  // A socket that closes before it opens asks whether the tab is signed in.
  vi.spyOn(api, "getMe").mockClear().mockResolvedValue({} as Awaited<ReturnType<typeof api.getMe>>);
  useStreamStore.setState({ bySession: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSocketHook(sessionId: string, sharedThreadId?: string) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, ...renderHook(() => useSessionWebSocket(sessionId, sharedThreadId), { wrapper }) };
}

describe("useSessionWebSocket", () => {
  it("keeps REST history when a second scoped view opens before any durable event", () => {
    const main = renderSocketHook("s1");
    act(() => useStreamStore.getState().setThreadMessages("s1", "parent", [{
      id: "saved-parent", sessionId: "s1", threadId: "parent", role: "assistant",
      content: "Saved answer", parts: [], createdAt: 1,
    }]));
    expect(useStreamStore.getState().bySession.s1.lastOffset).toBe("");
    const scoped = renderSocketHook("s1", "child");
    expect(useStreamStore.getState().bySession.s1.messages.map(message => message.id)).toEqual(["saved-parent"]);
    scoped.unmount();
    main.unmount();
  });

  it("keeps REST history when revisiting an idle session without an event cursor", () => {
    const initial = renderSocketHook("s1");
    act(() => useStreamStore.getState().setThreadMessages("s1", "parent", [{
      id: "saved-parent", sessionId: "s1", threadId: "parent", role: "assistant",
      content: "Saved answer", parts: [], createdAt: 1,
    }]));
    initial.unmount();
    const revisit = renderSocketHook("s1");
    expect(useStreamStore.getState().bySession.s1.messages.map(message => message.id)).toEqual(["saved-parent"]);
    revisit.unmount();
  });

  it("refreshes settings after a successful settings action, while unrelated and failed tools leave them alone", () => {
    const { queryClient } = renderSocketHook("s1");
    const key = ["settings", "me"];
    queryClient.setQueryData(key, { name: "Before" });
    const socket = FakeWebSocket.instances[0];
    const frame = (value: object) => act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, threadId: "t", ...value }) }));
    frame({ type: "tool_start", toolName: "call_tool", callId: "read", args: { tool_id: "settings.get_settings" } });
    frame({ type: "tool_end", toolName: "call_tool", callId: "read", result: "current", isError: false });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    frame({ type: "tool_start", toolName: "call_tool", callId: "failed", args: { tool_id: "settings.update_account" } });
    frame({ type: "tool_end", toolName: "call_tool", callId: "failed", result: "Denied", isError: true });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    frame({ type: "tool_start", toolName: "call_tool", callId: "saved", args: { tool_id: "settings.update_account" } });
    frame({ type: "tool_end", toolName: "call_tool", callId: "saved", result: "Saved", isError: false });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it.each(["settings__update_account", "settings__update_team", "settings__update_organization"])(
    "refreshes settings after successful pinned %s, while read, unrelated, and failed tools leave them alone",
    (toolName) => {
      const { queryClient } = renderSocketHook("s1");
      const key = ["settings", "me"];
      queryClient.setQueryData(key, { name: "Before" });
      const socket = FakeWebSocket.instances[0];
      const frame = (value: object) => act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, threadId: "t", ...value }) }));
      frame({ type: "tool_start", toolName: "settings__get_settings", callId: "read", args: {} });
      frame({ type: "tool_end", toolName: "settings__get_settings", callId: "read", result: "current", isError: false });
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      frame({ type: "tool_start", toolName: "teams__rename_team", callId: "unrelated", args: {} });
      frame({ type: "tool_end", toolName: "teams__rename_team", callId: "unrelated", result: "Saved", isError: false });
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      frame({ type: "tool_start", toolName, callId: "failed", args: {} });
      frame({ type: "tool_end", toolName, callId: "failed", result: "Denied", isError: true });
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      frame({ type: "tool_start", toolName, callId: "saved", args: {} });
      frame({ type: "tool_end", toolName, callId: "saved", result: "Saved", isError: false });
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    },
  );

  it("refreshes notification preferences after a successful notification settings change", () => {
    const { queryClient } = renderSocketHook("s1");
    const key = ["notifications", "preferences"];
    queryClient.setQueryData(key, { preferences: [] });
    const socket = FakeWebSocket.instances[0];
    const frame = (value: object) => act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, threadId: "t", ...value }) }));
    frame({ type: "tool_start", toolName: "call_tool", callId: "saved", args: { tool_id: "settings.update_notifications" } });
    frame({ type: "tool_end", toolName: "call_tool", callId: "saved", result: "Saved", isError: false });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it.each([
    { toolName: "call_tool", toolId: "settings.update_account", isError: false, refresh: true },
    { toolName: "settings__update_account", toolId: undefined, isError: false, refresh: true },
    { toolName: "call_tool", toolId: "settings.update_account", isError: true, refresh: false },
    { toolName: "settings__update_account", toolId: undefined, isError: true, refresh: false },
    { toolName: "call_tool", toolId: "settings.get_settings", isError: false, refresh: false },
    { toolName: "settings__get_settings", toolId: undefined, isError: false, refresh: false },
    { toolName: "call_tool", toolId: "teams.rename_team", isError: false, refresh: false },
    { toolName: "teams__rename_team", toolId: undefined, isError: false, refresh: false },
  ])("refreshes only successful settings writes after close/reopen: $toolName $toolId error=$isError", ({ toolName, toolId, isError, refresh }) => {
    const { queryClient, unmount } = renderSocketHook("s1");
    const key = ["settings", "me"];
    queryClient.setQueryData(key, { name: "Before" });
    const frame = (socket: FakeWebSocket | undefined, value: object) => act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, threadId: "t", ...value }) }));
    frame(FakeWebSocket.instances[0], { type: "message_start", messageId: "assistant", role: "assistant", offset: "0000000000000001" });
    frame(FakeWebSocket.instances[0], { type: "tool_start", toolName, callId: "saved", args: { tool_id: toolId }, offset: "0000000000000002" });
    unmount();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);
    const reopened = renderHook(() => useSessionWebSocket("s1"), { wrapper });
    expect(FakeWebSocket.instances[1]?.url).toContain("fromOffset=0000000000000002");
    frame(FakeWebSocket.instances[1], { type: "tool_end", toolName, callId: "saved", result: "Finished", isError, offset: "0000000000000003" });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(refresh);
    reopened.unmount();
  });

  it("marks the slice open on connect and closed on unmount", () => {
    const { unmount } = renderSocketHook("s1");
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
    const { unmount } = renderSocketHook("s1");
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

    // A socket that closes right after init keeps backing off.
    act(() => {
      third?.onopen?.();
      third?.onmessage?.({
        data: JSON.stringify({ type: "init", seq: 1, ts: 1, session: { id: "s1" } }),
      });
      third?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(1_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    const fourth = FakeWebSocket.instances[3];
    expect(fourth).toBeDefined();

    // One that stays open after init starts the backoff again.
    act(() => {
      fourth?.onopen?.();
      fourth?.onmessage?.({
        data: JSON.stringify({ type: "init", seq: 1, ts: 1, session: { id: "s1" } }),
      });
      vi.advanceTimersByTime(10_000);
      fourth?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(5);
    unmount();
  });

  it("refreshes persisted title caches after reconnect init", () => {
    vi.useFakeTimers();
    const { queryClient, unmount } = renderSocketHook("s1");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const first = FakeWebSocket.instances[0];

    act(() => {
      first?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500);
    });
    const reconnected = FakeWebSocket.instances[1];
    act(() =>
      reconnected?.onmessage?.({
        data: JSON.stringify({ type: "init", seq: 1, ts: 1, session: { id: "s1" } }),
      }),
    );

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ predicate: expect.any(Function) });
    unmount();
  });

  it("reports a dropped socket, and the init after its reconnect, to the app's connection state", () => {
    vi.useFakeTimers();
    const { unmount } = renderSocketHook("s1");
    const init = JSON.stringify({ type: "init", seq: 1, ts: 1, session: { id: "s1" } });
    const first = FakeWebSocket.instances[0];
    // The first init is not a recovery: nothing failed before it.
    act(() => first?.onmessage?.({ data: init }));
    expect(reportServerReachable).not.toHaveBeenCalled();

    act(() => {
      first?.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(500);
    });
    expect(reportServerUnavailable).toHaveBeenCalledTimes(1);
    act(() => FakeWebSocket.instances[1]?.onmessage?.({ data: init }));
    expect(reportServerReachable).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("refreshes persisted titles when the server finishes naming", () => {
    const { queryClient, unmount } = renderSocketHook("s1");
    queryClient.setQueryData<ListThreadsResponse>(["sessions", "root", "threads"], {
      threads: [{ id: "t1", sessionId: "s1", createdAt: 1, lastUserActivityAt: 1 }],
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const socket = FakeWebSocket.instances[0];

    act(() =>
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "title.updated",
          seq: 1,
          ts: 1,
          sessionId: "s1",
          threadId: "t1",
          sessionTitle: "Fix Authentication",
          threadTitle: "Fix Authentication",
        }),
      }),
    );

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ predicate: expect.any(Function) });
    expect(useStreamStore.getState().bySession.s1).toBeDefined();
    expect(queryClient.getQueryState(["sessions", "root", "threads"])?.isInvalidated).toBe(true);
    unmount();
  });

  it.each([
    ["the session's decisions", undefined, ["sessions", "s1", "decisions"]],
    ["a shared thread's decisions", "t1", ["thread-decisions", "t1"]],
  ])("refetches %s when a gate frame arrives during the first read", async (_name, sharedThreadId, queryKey) => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    // The first read starts before the gate opens and answers after the frame.
    const reads: Array<(gates: string[]) => void> = [];
    const queryFn = () => new Promise<string[]>((resolve) => { reads.push(resolve); });
    const { result, unmount } = renderHook(() => {
      useSessionWebSocket("s1", sharedThreadId);
      return useQuery({ queryKey, queryFn });
    }, { wrapper });
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({
      seq: 1, ts: 1, threadId: "t1", offset: "0000000000000001", type: "decision_gate",
      gate: { id: "g1", sessionId: "s1", threadId: "t1", type: "approval", title: "Approve?", actions: [], status: "pending", createdAt: 1, updatedAt: 1 },
    }) }));
    act(() => reads[0]?.([]));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(result.current.data).toBeUndefined();
    act(() => reads[1]?.(["g1"]));
    await waitFor(() => expect(result.current.data).toEqual(["g1"]));
    unmount();
  });

  it("refreshes a thread's plan after a successful update_plan call in that thread", () => {
    const { queryClient, unmount } = renderSocketHook("s1");
    const socket = FakeWebSocket.instances[0];
    const invalidated = (threadId: string) => queryClient.getQueryState(["thread-plan", threadId])?.isInvalidated;
    const reset = () => { for (const id of ["t1", "t2"]) queryClient.setQueryData(["thread-plan", id], { plan: null }); };
    const end = (toolName: string, isError: boolean) => act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, type: "tool_end", threadId: "t1", toolName, callId: "c1", result: "", isError }) }));

    reset();
    end("bash", false);
    end("update_plan", true);
    expect([invalidated("t1"), invalidated("t2")]).toEqual([false, false]);
    end("update_plan", false);
    expect([invalidated("t1"), invalidated("t2")]).toEqual([true, false]);
    unmount();
  });

  it("refreshes a thread's context reading after its turn, its settlement, its compaction, or a model switch", () => {
    const { queryClient, unmount } = renderSocketHook("s1");
    const reading = { context: { tokens: 1, limit: 10, contextWindow: 12, model: "m", autoCompact: true } };
    queryClient.setQueryData(["thread-context", "s1", "t1"], reading);
    queryClient.setQueryData(["thread-context", "s1", "t2"], reading);
    const socket = FakeWebSocket.instances[0];
    const invalidated = (threadId: string) => queryClient.getQueryState(["thread-context", "s1", threadId])?.isInvalidated;

    for (const frame of [
      { type: "turn_end", threadId: "t1", reason: "end_turn" },
      { type: "submission.settled", sessionId: "s1", threadId: "t1", queueItemId: "q1", outcome: "completed" },
      { type: "compaction_end", threadId: "t1" },
      { type: "model_switched", threadId: "t1", fromModel: "a", toModel: "b", reason: "user" },
    ]) {
      queryClient.setQueryData(["thread-context", "s1", "t1"], reading);
      act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, ...frame }) }));
      expect(invalidated("t1")).toBe(true);
      expect(invalidated("t2")).toBe(false);
    }

    // A session-level model switch changes every thread's budget.
    act(() => socket?.onmessage?.({ data: JSON.stringify({ seq: 2, ts: 2, type: "model_switched", fromModel: "a", toModel: "b", reason: "user" }) }));
    expect(invalidated("t2")).toBe(true);
    unmount();
  });

  it("updates cached activity without refetching loaded pages", () => {
    const { queryClient, unmount } = renderSocketHook("s1");
    queryClient.setQueryData<ListThreadsResponse>(["sessions", "s1", "threads"], {
      threads: [
        { id: "t1", sessionId: "s1", createdAt: 1, lastUserActivityAt: 10 },
        { id: "t2", sessionId: "s1", createdAt: 2, lastUserActivityAt: 20 },
      ],
    });
    queryClient.setQueryData<ListThreadsResponse>(["sessions", "root", "threads"], {
      threads: [
        { id: "t1", sessionId: "s1", createdAt: 1, lastUserActivityAt: 10 },
        { id: "other", sessionId: "s2", createdAt: 1, lastUserActivityAt: 5 },
      ],
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const pages = ["sessions", "root", "threads", "pages"];
    queryClient.setQueryData(pages, {
      pages: Array.from({ length: 5 }, (_, i) => ({ threads: [{ id: i === 0 ? "t1" : `page-${i}`, sessionId: "s1", createdAt: 1, lastUserActivityAt: 10 }] })), pageParams: [undefined, "2", "3", "4", "5"],
    });
    const unrelated = ["sessions", "other-workspace", "threads", "pages"];
    queryClient.setQueryData(unrelated, { pages: [{ threads: [] }], pageParams: [undefined] });
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "thread.activity",
          seq: 1,
          ts: 1,
          sessionId: "s1",
          threadId: "t1",
          lastUserActivityAt: 30,
        }),
      });
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "thread.activity",
          seq: 2,
          ts: 2,
          sessionId: "s1",
          threadId: "t1",
          lastUserActivityAt: 25,
        }),
      });
    });

    const cached = queryClient.getQueryData<ListThreadsResponse>(["sessions", "s1", "threads"]);
    expect(cached?.threads.find((thread) => thread.id === "t1")?.lastUserActivityAt).toBe(30);
    expect(cached?.threads.find((thread) => thread.id === "t2")?.lastUserActivityAt).toBe(20);
    expect(queryClient.getQueryData<ListThreadsResponse>(["sessions", "root", "threads"])?.threads.map(t => t.lastUserActivityAt)).toEqual([30, 5]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(pages)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["sessions", "s1", "threads"])?.isInvalidated).toBe(false);
    unmount();
  });

  it("stops reconnecting when the session does not exist", () => {
    vi.useFakeTimers();
    const { unmount } = renderSocketHook("missing");
    const socket = FakeWebSocket.instances[0];

    act(() => socket?.onclose?.({ code: 4040 }));
    expect(useStreamStore.getState().bySession.missing?.conn).toBe("error");
    act(() => vi.advanceTimersByTime(8_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("stops reconnecting when a refused upgrade comes from a signed-out tab", async () => {
    const getMe = vi.spyOn(api, "getMe").mockRejectedValue(new ApiError(401, "GET /me → 401", { error: "unauthorized" }));
    vi.useFakeTimers();
    const { unmount } = renderSocketHook("s1");
    // The upgrade is refused: the socket closes without opening.
    await act(async () => { FakeWebSocket.instances[0]?.onclose?.({ code: 1006 }); });
    expect(getMe).toHaveBeenCalledTimes(1);
    expect(useStreamStore.getState().bySession.s1?.conn).toBe("error");
    act(() => vi.advanceTimersByTime(8_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("keeps reconnecting after a refused upgrade when the tab is still signed in", async () => {
    const getMe = vi.spyOn(api, "getMe");
    vi.useFakeTimers();
    const { unmount } = renderSocketHook("s1");
    await act(async () => { FakeWebSocket.instances[0]?.onclose?.({ code: 1006 }); });
    expect(getMe).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(500));
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });

  it("shares one socket between views of one session, so streamed text is applied once", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);
    const chat = renderHook(() => useSessionWebSocket("s1"), { wrapper });
    const panel = renderHook(() => useSessionWebSocket("s1"), { wrapper });
    expect(FakeWebSocket.instances).toHaveLength(1);
    // The server sends every frame to every open socket of the session.
    const send = (value: object) => act(() => {
      for (const socket of FakeWebSocket.instances.filter(socket => !socket.closed)) socket.onmessage?.({ data: JSON.stringify({ seq: 1, ts: 1, threadId: "t", ...value }) });
    });
    send({ type: "message_start", messageId: "m1", role: "assistant", offset: "0000000000000001" });
    send({ type: "text_delta", messageId: "m1", delta: "Hello" });
    expect(useStreamStore.getState().bySession.s1?.messages.find(message => message.id === "m1")?.content).toBe("Hello");

    // Closing one view keeps the other live on the same socket.
    act(() => FakeWebSocket.instances[0]?.onopen?.());
    chat.unmount();
    expect(FakeWebSocket.instances[0]?.closed).toBe(false);
    expect(useStreamStore.getState().bySession.s1?.conn).toBe("open");
    send({ type: "text_delta", messageId: "m1", delta: " there" });
    expect(useStreamStore.getState().bySession.s1?.messages.find(message => message.id === "m1")?.content).toBe("Hello there");

    panel.unmount();
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    expect(useStreamStore.getState().bySession.s1?.conn).toBe("closed");
  });

  it("retries application close codes that are not terminal for the session stream", () => {
    vi.useFakeTimers();
    const { unmount } = renderSocketHook("s1");
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket?.onclose?.({ code: 4009 });
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });
});


it("makes an unloaded execution thread reachable in its root workspace without reloading pages", async () => {
  const row = { id: "recent", sessionId: "s1", createdAt: 10, lastUserActivityAt: 10 };
  const list = vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => ({
    threads: [opts?.fixedOnly ? { ...row, id: "old", createdAt: 1, lastUserActivityAt: 20 } : row],
    nextCursor: opts?.fixedOnly ? undefined : "older",
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const { result, unmount } = renderHook(() => {
    useSessionWebSocket("execution:old");
    return useSidebarThreads("s1", { sort: "last-user-activity", origin: "all", fixedIds: [] });
  }, { wrapper });
  await waitFor(() => expect(result.current.data?.threads).toHaveLength(1));
  act(() => FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: "thread.activity", threadId: "old", lastUserActivityAt: 20, seq: 1, ts: 20 }) }));
  await waitFor(() => expect(result.current.data?.threads.some(thread => thread.id === "old")).toBe(true));
  expect(list.mock.calls.filter(([, opts]) => opts?.limit)).toHaveLength(1);
  expect(list).toHaveBeenLastCalledWith("s1", { fixedOnly: true, fixedIds: ["old"] });
  unmount(); client.clear(); vi.restoreAllMocks();
});
