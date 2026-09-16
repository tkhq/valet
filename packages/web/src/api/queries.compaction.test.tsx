// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamStore } from "~/stores/stream";
import { api } from "./client";
import { useSendPrompt } from "./queries";

const SESSION = "session-1";
const THREAD = "thread-1";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useStreamStore.setState({ bySession: {} });
});

describe("useSendPrompt compaction ownership", () => {
  it("clears optimistic state when its own compact request fails", async () => {
    vi.spyOn(api, "sendPrompt").mockRejectedValue(new Error("request failed"));
    const { result } = renderHook(() => useSendPrompt(SESSION), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ text: "/compact", threadId: THREAD }),
      ).rejects.toThrow("request failed");
    });

    expect(
      useStreamStore.getState().bySession[SESSION]?.compactingByThread[THREAD],
    ).toBeUndefined();
  });

  it("does not clear an already-active pass when a duplicate request fails", async () => {
    useStreamStore.getState().setCompacting(SESSION, THREAD, true);
    vi.spyOn(api, "sendPrompt").mockRejectedValue(new Error("already compacting"));
    const { result } = renderHook(() => useSendPrompt(SESSION), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ text: "/compact", threadId: THREAD }),
      ).rejects.toThrow("already compacting");
    });

    await waitFor(() => {
      expect(
        useStreamStore.getState().bySession[SESSION]?.compactingByThread[THREAD],
      ).toBe(true);
    });
  });
});
