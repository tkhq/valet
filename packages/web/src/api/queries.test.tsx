// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { ListMessagesResponse, ListThreadsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { prefetchSession, prefetchTranscript, qk, TRANSCRIPT_FULL, TRANSCRIPT_TAIL, useMarkThreadsRead, useMessages, useSendPrompt, useSession, useSetThreadModel } from "./queries";

const sessionId = "session-1";

describe("useSendPrompt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("updates the sender's submitted thread activity before a socket event arrives", async () => {
    vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "message-1", threadId: "older", activityAt: 3_000 });
    const client = new QueryClient();
    client.setQueryData<ListThreadsResponse>(qk.threads(sessionId), {
      threads: [
        { id: "older", sessionId, createdAt: 1_000, lastUserActivityAt: 1_000, key: "web:older" },
        { id: "newer", sessionId, createdAt: 2_000, lastUserActivityAt: 2_000, key: "web:newer" },
      ],
    });
    client.setQueryData<ListThreadsResponse>(qk.threads("root"), client.getQueryData<ListThreadsResponse>(qk.threads(sessionId)));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSendPrompt(sessionId), { wrapper });

    await act(() => result.current.mutateAsync({ text: "Move this thread" }));

    const threads = client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads;
    expect(threads?.find((thread) => thread.id === "older")?.lastUserActivityAt).toBe(3_000);
    expect(threads?.find((thread) => thread.id === "newer")?.lastUserActivityAt).toBe(2_000);
    expect(client.getQueryData<ListThreadsResponse>(qk.threads("root"))?.threads[0]?.lastUserActivityAt).toBe(3_000);
  });
});


describe("useSetThreadModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies the confirmed model without another fetch and preserves newer thread fields", async () => {
    let complete: ((response: Awaited<ReturnType<typeof api.patchThread>>) => void) | undefined;
    vi.spyOn(api, "patchThread").mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const client = new QueryClient();
    client.setQueryData<ListThreadsResponse>(qk.threads(sessionId), {
      threads: [
        { id: "chosen", sessionId, createdAt: 1, model: "s", lastUserActivityAt: 99 },
        { id: "other", sessionId, createdAt: 2, lastUserActivityAt: 2, model: "m" },
      ],
    });
    client.setQueryData<ListThreadsResponse>(qk.threads("root"), client.getQueryData<ListThreadsResponse>(qk.threads(sessionId)));
    let finishOldRead: ((value: ListThreadsResponse) => void) | undefined;
    const oldRead = client.fetchQuery({
      queryKey: qk.threads(sessionId),
      queryFn: () => new Promise<ListThreadsResponse>((resolve) => { finishOldRead = resolve; }),
    }).catch(() => undefined);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetThreadModel(sessionId), { wrapper });
    act(() => result.current.mutate({ threadId: "chosen", model: "l" }));
    await waitFor(() => expect(complete).toBeDefined());
    expect(client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads[0]?.model).toBe("s");
    act(() => complete?.({ id: "chosen", sessionId, createdAt: 1, lastUserActivityAt: 1, model: "l" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads).toEqual([
      { id: "chosen", sessionId, createdAt: 1, model: "l", lastUserActivityAt: 99 },
      { id: "other", sessionId, createdAt: 2, lastUserActivityAt: 2, model: "m" },
    ]);
    finishOldRead?.({ threads: [{ id: "chosen", sessionId, createdAt: 1, lastUserActivityAt: 1, model: "s" }] });
    await oldRead;
    expect(client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads[0]?.model).toBe("l");
    expect(client.getQueryData<ListThreadsResponse>(qk.threads("root"))?.threads[0]?.model).toBe("l");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps the saved model after the server rejects a switch", async () => {
    vi.spyOn(api, "patchThread").mockRejectedValue(new Error("Model unavailable. Choose another model."));
    const client = new QueryClient();
    client.setQueryData<ListThreadsResponse>(qk.threads(sessionId), {
      threads: [{ id: "chosen", sessionId, createdAt: 1, lastUserActivityAt: 1, model: "s" }],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetThreadModel(sessionId), { wrapper });
    act(() => result.current.mutate({ threadId: "chosen", model: "l" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads[0]?.model).toBe("s");
  });
});

describe("useSidebarThreads", () => {
  afterEach(() => vi.restoreAllMocks());
  it("requests ten rows, retains rows after an error, retries, and isolates workspace pages", async () => {
    const { useSidebarThreads } = await import("./queries");
    const row = { id: "one", sessionId, createdAt: 1, lastUserActivityAt: 1 };
    const list = vi.spyOn(api, "listThreads")
      .mockResolvedValueOnce({ threads: [row], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ threads: [row, { ...row, id: "two" }] })
      .mockResolvedValueOnce({ threads: [{ ...row, id: "team", sessionId: "team" }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ id }) => useSidebarThreads(id, { sort: "created", origin: "all", fixedIds: [] }), { wrapper, initialProps: { id: sessionId } });
    await waitFor(() => expect(result.current.data?.threads).toHaveLength(1));
    expect(list).toHaveBeenNthCalledWith(1, sessionId, { sort: "created", origin: "all", limit: 10, cursor: undefined });
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data?.threads).toEqual([row]);
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.threads).toHaveLength(2));
    expect(list.mock.calls[2]?.[1]?.cursor).toBe("next");
    rerender({ id: "team" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.threads[0]?.id).toBe("team"));
    client.clear();
  });
  it("keeps loaded pages when selection, pins, and project assignments change", async () => {
    const { useSidebarThreads } = await import("./queries");
    const row = { id: "one", sessionId, createdAt: 1, lastUserActivityAt: 1 };
    const list = vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => ({
      threads: opts?.fixedIds?.length ? opts.fixedIds.map(id => ({ ...row, id })) : [{ ...row, id: opts?.cursor === "3" ? "three" : opts?.cursor ? "two" : "one" }],
      nextCursor: opts?.cursor === "3" ? undefined : opts?.cursor ? "3" : "2",
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ fixedIds, threadId }) => useSidebarThreads(sessionId, { sort: "created", origin: "all", fixedIds, threadId }), {
      wrapper, initialProps: { fixedIds: [] as string[], threadId: undefined as string | undefined },
    });
    await waitFor(() => expect(result.current.data?.threads).toHaveLength(1));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.threads.map(t => t.id)).toEqual(["one", "two"]));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.threads).toHaveLength(3));
    rerender({ fixedIds: ["pin", "project", "gate"], threadId: "two" });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.threads.map(t => t.id)).toEqual(["one", "two", "three"]);
    await waitFor(() => expect(result.current.data?.threads.some(t => t.id === "project")).toBe(true));
    expect(result.current.data?.threads.some(t => t.id === "two")).toBe(true);
    expect(list.mock.calls.filter(([, opts]) => opts?.limit === 10)).toHaveLength(3);
    const calls = list.mock.calls.length;
    rerender({ fixedIds: ["gate", "pin", "project"], threadId: "two" });
    expect(list.mock.calls).toHaveLength(calls);
    rerender({ fixedIds: ["gate", "pin", "project"], threadId: "three" });
    expect(result.current.data?.threads.some(t => t.id === "project")).toBe(true);
    client.clear();
  });

});

describe("paged thread read state", () => {
  afterEach(() => vi.restoreAllMocks());
  it("marks loaded workspace pages without marking sibling execution sessions read", async () => {
    vi.spyOn(api, "markThreadsRead").mockResolvedValue(undefined);
    const client = new QueryClient();
    const row = { id: "one", sessionId, createdAt: 1, lastUserActivityAt: 1 };
    const key = qk.threadPages(sessionId);
    client.setQueryData<InfiniteData<ListThreadsResponse>>(key, { pages: [{ threads: [row] }], pageParams: [undefined] });
    client.setQueryData<InfiniteData<ListThreadsResponse>>(qk.threadPages("root"), {
      pages: [{ threads: [row, { ...row, id: "sibling", sessionId: "sibling" }] }], pageParams: [undefined],
    });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMarkThreadsRead(sessionId), { wrapper });
    await act(() => result.current.mutateAsync({}));
    expect(client.getQueryData<InfiniteData<ListThreadsResponse>>(key)?.pages[0]?.threads[0]?.readAt).toBeGreaterThan(0);
    const embedded = client.getQueryData<InfiniteData<ListThreadsResponse>>(qk.threadPages("root"))?.pages[0]?.threads;
    expect(embedded?.[0]?.readAt).toBeGreaterThan(0);
    expect(embedded?.[1]?.readAt).toBeUndefined();
    client.clear();
  });
});

it("batches hundreds of fixed IDs into bounded requests without dropping rows", async () => {
  const { fixedThreadBatches, useSidebarThreads } = await import("./queries");
  const ids = Array.from({ length: 280 }, (_, i) => `project-thread-${i.toString().padStart(4, "0")}`);
  const batches = fixedThreadBatches(ids);
  expect(batches.flat()).toEqual(ids);
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(50);
    expect(new URLSearchParams(batch.map(id => ["fixedId", id])).toString().length).toBeLessThan(3000);
  }
  const list = vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => ({ threads: (opts?.fixedIds ?? ["recent"]).map(id => ({ id, sessionId, createdAt: 1, lastUserActivityAt: 1 })) }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useSidebarThreads(sessionId, { sort: "created", origin: "chat", fixedIds: ids }), { wrapper });
  await waitFor(() => expect(result.current.data?.threads).toHaveLength(281));
  expect(list.mock.calls.filter(([,opts]) => opts?.fixedOnly)).toHaveLength(6);
  client.clear();
  vi.restoreAllMocks();
});

it("drops supplemental selection rows when selection clears during archive", async () => {
  const { useSidebarThreads, useSetThreadArchived } = await import("./queries");
  const row = { id: "old", sessionId, createdAt: 1, lastUserActivityAt: 1 };
  vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => ({ threads: opts?.fixedOnly ? [row] : [{ ...row, id: "recent" }] }));
  vi.spyOn(api, "patchThread").mockResolvedValue({ ...row, archivedAt: 2 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender, unmount } = renderHook(({ threadId }) => ({
    sidebar: useSidebarThreads(sessionId, { sort: "last-user-activity", origin: "all", fixedIds: [], threadId }),
    archive: useSetThreadArchived(sessionId),
  }), { wrapper, initialProps: { threadId: "old" as string | undefined } });
  await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
  rerender({ threadId: undefined });
  await act(() => result.current.archive.mutateAsync({ threadId: "old", archived: true }));
  await waitFor(() => expect(result.current.sidebar.data?.threads.map(t => t.id)).toEqual(["recent"]));
  unmount(); client.clear(); vi.restoreAllMocks();
});

it("inserts promoted unloaded rows with one bounded read and preserves loaded cursors", async () => {
  const { useSidebarThreads, refreshMissingActivityThread } = await import("./queries");
  const row = { id: "recent", sessionId, createdAt: 10, lastUserActivityAt: 10 };
  const list = vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => opts?.fixedOnly
    ? { threads: [{ ...row, id: "promoted", createdAt: 1, lastUserActivityAt: 20 }] }
    : { threads: [{ ...row, id: opts?.cursor ? "older" : "recent" }], nextCursor: opts?.cursor ? "last" : "next" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useSidebarThreads(sessionId, { sort: "last-user-activity", origin: "all", fixedIds: [] }), { wrapper });
  await waitFor(() => expect(result.current.data?.threads).toHaveLength(1));
  await act(() => result.current.fetchNextPage());
  await act(() => refreshMissingActivityThread(client, "promoted"));
  await waitFor(() => expect(result.current.data?.threads.map(t => t.id)).toContain("promoted"));
  await act(() => refreshMissingActivityThread(client, "promoted"));
  expect(list.mock.calls.filter(([, opts]) => opts?.limit)).toHaveLength(2);
  expect(list.mock.calls.filter(([, opts]) => opts?.fixedOnly)).toHaveLength(1);
  expect(client.getQueryData<InfiniteData<ListThreadsResponse>>(qk.threadPages(sessionId, { sort: "last-user-activity", origin: "all" }))?.pages[1]?.nextCursor).toBe("last");
  unmount(); client.clear(); vi.restoreAllMocks();
});

it("does not resurrect an archived thread from a pending activity read", async () => {
  const { useSidebarThreads, useSetThreadArchived, refreshMissingActivityThread } = await import("./queries");
  const row = { id: "old", sessionId, createdAt: 1, lastUserActivityAt: 20 };
  let complete!: (response: ListThreadsResponse) => void;
  vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => opts?.fixedOnly
    ? new Promise<ListThreadsResponse>(resolve => { complete = resolve; }) : { threads: [{ ...row, id: "recent" }] });
  vi.spyOn(api, "patchThread").mockResolvedValue({ ...row, archivedAt: 21 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, { sort: "last-user-activity", origin: "all", fixedIds: [] }), archive: useSetThreadArchived(sessionId) }), { wrapper });
  await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(1));
  const pending = refreshMissingActivityThread(client, "old").catch(() => undefined);
  await waitFor(() => expect(complete).toBeDefined());
  await act(() => result.current.archive.mutateAsync({ threadId: "old", archived: true }));
  await act(async () => { complete({ threads: [row] }); await pending; });
  expect(result.current.sidebar.data?.threads.map(thread => thread.id)).toEqual(["recent"]);
  unmount(); client.clear(); vi.restoreAllMocks();
});


describe("thread transcript", () => {
  afterEach(() => vi.restoreAllMocks());
  const page = (id: string): ListMessagesResponse => ({ messages: [{ id, sessionId, threadId: "t1", role: "user", content: id, parts: [], createdAt: 1 }], hasMore: true });

  it("joins a prefetch still in flight instead of asking twice, newest page first", async () => {
    let finish: (value: ListMessagesResponse) => void = () => {};
    const list = vi.spyOn(api, "listMessages").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient();
    prefetchTranscript(client, "t1");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMessages(sessionId, "t1"), { wrapper });
    act(() => finish(page("m1")));
    await waitFor(() => expect(result.current.data?.messages[0]?.id).toBe("m1"));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("", { limit: TRANSCRIPT_TAIL, threadId: "t1" });
  });

  it("lets the thread view share a session prefetch still in flight", async () => {
    let finish: (value: Awaited<ReturnType<typeof api.getSession>>) => void = () => {};
    const get = vi.spyOn(api, "getSession").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient();
    prefetchSession(client, sessionId);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSession(sessionId), { wrapper });
    act(() => finish({ id: sessionId } as Awaited<ReturnType<typeof api.getSession>>));
    await waitFor(() => expect(result.current.data?.id).toBe(sessionId));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("shows a finished prefetch at once, and keeps it while the full history loads", async () => {
    const list = vi.spyOn(api, "listMessages").mockResolvedValueOnce(page("newest")).mockImplementation(() => new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
    prefetchTranscript(client, "t1");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ limit }) => useMessages(sessionId, "t1", undefined, limit), { wrapper, initialProps: { limit: TRANSCRIPT_TAIL } });
    expect(result.current.data?.messages[0]?.id).toBe("newest");
    rerender({ limit: TRANSCRIPT_FULL });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.messages[0]?.id).toBe("newest");
    expect(list).toHaveBeenLastCalledWith("", { limit: TRANSCRIPT_FULL, threadId: "t1" });
  });
});

describe("optimistic thread actions", () => {
  afterEach(() => vi.restoreAllMocks());
  const options = { sort: "last-user-activity", origin: "all", fixedIds: [] };
  const rows = [{ id: "a", sessionId, createdAt: 2, lastUserActivityAt: 2, title: "Alpha" }, { id: "b", sessionId, createdAt: 1, lastUserActivityAt: 1, title: "Beta" }];
  type Patch = Awaited<ReturnType<typeof api.patchThread>>;
  function setup() {
    const archived: string[] = [];
    // Offline: the reads that would correct the lists fail too.
    const network = { offline: false };
    const list = vi.spyOn(api, "listThreads").mockImplementation(async (_id, opts) => network.offline ? Promise.reject(new Error("Offline.")) : opts?.archived
      ? { threads: rows.filter(row => archived.includes(row.id)) }
      : { threads: rows.filter(row => !archived.includes(row.id)) });
    const saves: Array<{ resolve: (value: Patch) => void; reject: (error: Error) => void }> = [];
    vi.spyOn(api, "patchThread").mockImplementation(() => new Promise<Patch>((resolve, reject) => { saves.push({ resolve, reject }); }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { archived, list, saves, client, wrapper, network };
  }

  it("moves an archived row at once and moves it back when a running turn refuses it", async () => {
    const { useSidebarThreads, useArchivedThreads, useSetThreadArchived } = await import("./queries");
    const { ApiError } = await import("./client");
    const { saves, client, wrapper } = setup();
    const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, options), archivedList: useArchivedThreads(sessionId), archive: useSetThreadArchived(sessionId) }), { wrapper });
    await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
    await waitFor(() => expect(result.current.archivedList.data).toBeDefined());
    let done: Promise<unknown> | undefined;
    act(() => { done = result.current.archive.mutateAsync({ threadId: "a", archived: true }).catch(() => undefined); });
    // The row moves before the server answers.
    await waitFor(() => expect(result.current.sidebar.data?.threads.map(thread => thread.id)).toEqual(["b"]));
    expect(result.current.archivedList.data?.threads.map(thread => thread.id)).toEqual(["a"]);
    expect(saves).toHaveLength(1);
    await act(async () => { saves[0]!.reject(new ApiError(409, "PATCH → 409", { error: "A turn is running in this thread. Wait for it to finish, then archive." })); await done; });
    await waitFor(() => expect(result.current.sidebar.data?.threads.map(thread => thread.id)).toContain("a"));
    expect(result.current.archivedList.data?.threads ?? []).toEqual([]);
    unmount(); client.clear();
  });

  it("reads the lists once, after the last of several quick archives", async () => {
    const { useSidebarThreads, useSetThreadArchived } = await import("./queries");
    const { archived, list, saves, client, wrapper } = setup();
    const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, options), archive: useSetThreadArchived(sessionId) }), { wrapper });
    await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
    const reads = list.mock.calls.length;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.archive.mutateAsync({ threadId: "a", archived: true });
      second = result.current.archive.mutateAsync({ threadId: "b", archived: true });
    });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(result.current.sidebar.data?.threads).toEqual([]);
    archived.push("a");
    await act(async () => { saves[0]!.resolve({ ...rows[0]!, archivedAt: 3 }); await first; });
    // A read now would show b again, because its save still runs.
    expect(list.mock.calls.length).toBe(reads);
    expect(result.current.sidebar.data?.threads).toEqual([]);
    archived.push("b");
    await act(async () => { saves[1]!.resolve({ ...rows[1]!, archivedAt: 4 }); await second; });
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
    expect(result.current.sidebar.data?.threads).toEqual([]);
    unmount(); client.clear();
  });

  it("ends in the server's state when an archive and a quick restore both fail", async () => {
    const { useSidebarThreads, useArchivedThreads, useSetThreadArchived } = await import("./queries");
    const { saves, client, wrapper, network } = setup();
    const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, options), archivedList: useArchivedThreads(sessionId), archive: useSetThreadArchived(sessionId) }), { wrapper });
    await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
    await waitFor(() => expect(result.current.archivedList.data).toBeDefined());
    network.offline = true;
    let archiving: Promise<unknown> | undefined;
    let restoring: Promise<unknown> | undefined;
    act(() => { archiving = result.current.archive.mutateAsync({ threadId: "a", archived: true }).catch(() => undefined); });
    await waitFor(() => expect(result.current.archivedList.data?.threads.map(thread => thread.id)).toEqual(["a"]));
    act(() => { restoring = result.current.archive.mutateAsync({ threadId: "a", archived: false }).catch(() => undefined); });
    await waitFor(() => expect(saves).toHaveLength(2));
    // The archive's failure arrives first, then the restore's.
    await act(async () => { saves[0]!.reject(new Error("Offline. Reconnect and retry.")); await archiving; });
    await act(async () => { saves[1]!.reject(new Error("Offline. Reconnect and retry.")); await restoring; });
    // The server never archived it, and no read can say so (observers update on the next tick).
    await waitFor(() => expect(result.current.sidebar.data?.threads.map(thread => thread.id)).toContain("a"));
    await waitFor(() => expect(result.current.archivedList.data?.threads ?? []).toEqual([]));
    unmount(); client.clear();
  });

  it("keeps the server's title when two quick renames both fail out of order", async () => {
    const { useSidebarThreads, useRenameThread } = await import("./queries");
    const { saves, client, wrapper, network } = setup();
    const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, options), rename: useRenameThread(sessionId) }), { wrapper });
    await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
    network.offline = true;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => { first = result.current.rename.mutateAsync({ threadId: "a", title: "One" }).catch(() => undefined); });
    await waitFor(() => expect(saves).toHaveLength(1));
    act(() => { second = result.current.rename.mutateAsync({ threadId: "a", title: "Two" }).catch(() => undefined); });
    await waitFor(() => expect(saves).toHaveLength(2));
    await act(async () => { saves[0]!.reject(new Error("Offline.")); await first; });
    await act(async () => { saves[1]!.reject(new Error("Offline.")); await second; });
    await waitFor(() => expect(result.current.sidebar.data?.threads.find(thread => thread.id === "a")?.title).toBe("Alpha"));
    unmount(); client.clear();
  });

  it("shows a new title at once and restores the old one when the save fails", async () => {
    const { useSidebarThreads, useRenameThread } = await import("./queries");
    const { saves, client, wrapper } = setup();
    const { result, unmount } = renderHook(() => ({ sidebar: useSidebarThreads(sessionId, options), rename: useRenameThread(sessionId) }), { wrapper });
    await waitFor(() => expect(result.current.sidebar.data?.threads).toHaveLength(2));
    let done: Promise<unknown> | undefined;
    act(() => { done = result.current.rename.mutateAsync({ threadId: "a", title: "Renamed" }).catch(() => undefined); });
    await waitFor(() => expect(result.current.sidebar.data?.threads.find(thread => thread.id === "a")?.title).toBe("Renamed"));
    expect(saves).toHaveLength(1);
    await act(async () => { saves[0]!.reject(new Error("Offline. Reconnect and retry.")); await done; });
    await waitFor(() => expect(result.current.sidebar.data?.threads.find(thread => thread.id === "a")?.title).toBe("Alpha"));
    unmount(); client.clear();
  });
});
