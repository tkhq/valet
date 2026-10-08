// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListThreadsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { qk, useSendPrompt, useSetThreadModel } from "./queries";

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
