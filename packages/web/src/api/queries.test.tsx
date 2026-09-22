// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListThreadsResponse } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { qk, useSendPrompt } from "./queries";

const sessionId = "session-1";

describe("useSendPrompt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("updates the sender's submitted thread activity before a socket event arrives", async () => {
    vi.spyOn(api, "sendPrompt").mockResolvedValue({ messageId: "message-1", threadId: "older" });
    const client = new QueryClient();
    client.setQueryData<ListThreadsResponse>(qk.threads(sessionId), {
      threads: [
        { id: "older", sessionId, createdAt: 1_000, lastUserActivityAt: 1_000, key: "web:older" },
        { id: "newer", sessionId, createdAt: 2_000, lastUserActivityAt: 2_000, key: "web:newer" },
      ],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSendPrompt(sessionId), { wrapper });

    await act(() => result.current.mutateAsync({ text: "Move this thread" }));

    const threads = client.getQueryData<ListThreadsResponse>(qk.threads(sessionId))?.threads;
    expect(threads?.find((thread) => thread.id === "older")?.lastUserActivityAt).toBeGreaterThan(2_000);
    expect(threads?.find((thread) => thread.id === "newer")?.lastUserActivityAt).toBe(2_000);
  });
});
