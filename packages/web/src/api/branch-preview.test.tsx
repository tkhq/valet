// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "./client";
import { useBranchPreview } from "./branch-preview";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

afterEach(() => vi.restoreAllMocks());

describe("branch preview", () => {
  it("encodes the thread and selected note in the read-only request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }));
    await api.branchPreview("thread/a", "note?b&c", "older/a?b");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/threads/thread%2Fa/branch-preview?noteEntryId=note%3Fb%26c&cursor=older%2Fa%3Fb"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("waits for a thread and fetches the selected version", async () => {
    const preview = vi.spyOn(api, "branchPreview").mockResolvedValue({ messages: [], hasMore: false });
    const initialProps: { threadId: string | undefined } = { threadId: undefined };
    const { result, rerender } = renderHook(({ threadId }: { threadId: string | undefined }) => useBranchPreview(threadId, "note-1"), {
      initialProps, wrapper,
    });
    expect(preview).not.toHaveBeenCalled();
    rerender({ threadId: "thread-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(preview).toHaveBeenCalledWith("thread-1", "note-1", undefined);
  });
});
