// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserResponse } from "@valet/shared";
import {
  browserApi,
  useBrowserActions,
  useBrowserAnnotations,
} from "./browser";

afterEach(() => vi.restoreAllMocks());

it("sends dialog responses while preserving the order of pending page inputs", async () => {
  let finishClick: (response: BrowserResponse) => void = () => {};
  const response: BrowserResponse = {
    ok: true,
    protocolVersion: "1.0",
    runtimeId: "runtime",
    events: [],
    cursor: 0,
    gap: false,
  };
  const pendingClick = new Promise<BrowserResponse>((resolve) => {
    finishClick = resolve;
  });
  const transport = vi
    .spyOn(browserApi, "input")
    .mockImplementation(async (_session, body) => {
      if (body.input.type === "pointer") return pendingClick;
      return response;
    });
  const cache = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const view = renderHook(() => useBrowserActions("session"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    ),
  });
  const identity = {
    runtimeId: "runtime",
    leaseId: "lease",
    tabId: "tab",
    documentId: "doc",
  };
  act(() => {
    view.result.current.input.mutate({
      ...identity,
      input: { type: "pointer", phase: "up", x: 10, y: 10, button: "left" },
    });
    view.result.current.input.mutate({
      ...identity,
      input: { type: "reload" },
    });
  });
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  await act(async () => {
    await view.result.current.dialog.mutateAsync({
      ...identity,
      input: { type: "dialog", dialogId: "dialog", accept: true },
    });
  });
  expect(transport.mock.calls.map((call) => call[1].input.type)).toEqual([
    "pointer",
    "dialog",
  ]);
  await act(async () => finishClick(response));
  await waitFor(() =>
    expect(transport.mock.calls.map((call) => call[1].input.type)).toEqual([
      "pointer",
      "dialog",
      "reload",
    ]),
  );
  view.unmount();
  cache.clear();
});

it("refreshes annotation staleness while the editor remains open", async () => {
  vi.useFakeTimers();
  try {
    const transport = vi
      .spyOn(browserApi, "annotations")
      .mockResolvedValue({ annotations: [] });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5000 } },
    });
    const view = renderHook(
      () => useBrowserAnnotations("session", "artifact"),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={cache}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(transport).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(transport).toHaveBeenCalledTimes(2);
    view.unmount();
    cache.clear();
  } finally {
    vi.useRealTimers();
  }
});
