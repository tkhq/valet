// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ListBakeQueueResponse } from "./sources";

vi.mock("./client", () => ({ api: { listBakeQueue: vi.fn(), reorderBakeQueue: vi.fn() } }));
import { api } from "./client";
import { useBakeQueue, useReorderBakeQueue } from "./sources";

it("keeps reordering pending until the authoritative queue refresh completes", async () => {
  const data: ListBakeQueueResponse = { builderAvailable: true, reorderAvailable: true, running: [], queued: [], recent: [], blocked: [] };
  let finishRefresh: (data: ListBakeQueueResponse) => void = () => {};
  const refresh = new Promise<ListBakeQueueResponse>((resolve) => { finishRefresh = resolve; });
  vi.mocked(api.listBakeQueue).mockResolvedValueOnce(data).mockReturnValueOnce(refresh);
  vi.mocked(api.reorderBakeQueue).mockResolvedValue({ ok: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => ({ queue: useBakeQueue(), reorder: useReorderBakeQueue() }), { wrapper });
  await waitFor(() => expect(result.current.queue.data).toEqual(data));
  act(() => result.current.reorder.mutate([]));
  await waitFor(() => expect(api.listBakeQueue).toHaveBeenCalledTimes(2));
  expect(result.current.reorder.isPending).toBe(true);
  await act(async () => { finishRefresh(data); });
  await waitFor(() => expect(result.current.reorder.isPending).toBe(false));
  unmount();
  client.clear();
});
