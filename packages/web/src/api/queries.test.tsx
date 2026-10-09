// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { ListThreadsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { qk, useMarkThreadsRead, useSendPrompt, useSetThreadModel } from "./queries";

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
