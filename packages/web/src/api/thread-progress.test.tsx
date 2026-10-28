// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import type { TurnProgress } from "@valet/shared";
import { api } from "./client";
import { qkThreadProgress, useThreadProgress } from "./thread-progress";

const progress: TurnProgress = {
  turnId: "turn", title: "Task progress", status: "waiting", revision: "1",
  updatedAt: 1, tasks: [], omittedTasks: 0,
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["pending", "in_progress", "waiting", "complete", "error", "interrupted", null] as const)("does not poll %s snapshots: thread WebSocket events trigger refreshes", async status => {
  vi.useFakeTimers();
  const read = vi.spyOn(api, "getThreadProgress");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qkThreadProgress("shared"), { progress: status ? { ...progress, status } : null });
  client.setQueryData(qkThreadProgress("other"), { progress });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { unmount } = renderHook(() => useThreadProgress("shared"), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(read).not.toHaveBeenCalled();
  unmount();
});

it("does not fetch without a selected thread", async () => {
  const read = vi.spyOn(api, "getThreadProgress");
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useThreadProgress(undefined), { wrapper });
  expect(result.current.fetchStatus).toBe("idle");
  expect(read).not.toHaveBeenCalled();
});
