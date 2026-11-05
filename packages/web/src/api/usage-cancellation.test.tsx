// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUsageBreakdown, useUsageItems, useUsageOutcomes, useUsageToolEfficiency } from "./usage";
import { useProxyRequests, useProxySettings } from "./proxy-usage";

let client: QueryClient;
let requests: Array<{ url: string; signal: AbortSignal }>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("A cancellable request needs a signal.");
    requests.push({ url, signal });
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })));
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

it("cancels pending details on rapid view and period changes without cancelling shared totals", async () => {
  const { rerender, unmount } = renderHook(({ view, window }: { view: string; window: "7d" | "30d" }) => {
    const period = { kind: "lookback", window } as const;
    useUsageBreakdown(period, "me");
    useUsageItems(period, "me", "session", undefined, { enabled: view === "breakdown" });
    useUsageOutcomes(period, "me", undefined, { enabled: view === "breakdown" });
    useUsageToolEfficiency(period, "me", undefined, { enabled: view === "breakdown" });
    useProxyRequests({ limit: 25 }, { enabled: view === "activity" });
    useProxySettings({ enabled: view === "activity" });
  }, { initialProps: { view: "breakdown", window: "7d" }, wrapper });
  await waitFor(() => expect(requests).toHaveLength(4));
  const first = [...requests];
  rerender({ view: "activity", window: "7d" });
  await waitFor(() => expect(requests).toHaveLength(6));
  expect(first.filter(r => !r.url.includes("/usage/breakdown?")).every(r => r.signal.aborted)).toBe(true);
  expect(first[0].signal.aborted).toBe(false);
  const proxy = requests.filter(r => r.url.includes("/proxy/"));
  rerender({ view: "breakdown", window: "30d" });
  await waitFor(() => expect(requests).toHaveLength(10));
  expect(first.every(r => r.signal.aborted)).toBe(true);
  expect(proxy.every(r => r.signal.aborted)).toBe(true);
  const second = requests.slice(6);
  expect(second.every(r => r.url.includes("window=30d") && !r.signal.aborted)).toBe(true);
  rerender({ view: "breakdown", window: "7d" });
  await waitFor(() => expect(requests).toHaveLength(14));
  expect(second.every(r => r.signal.aborted)).toBe(true);
  const third = requests.slice(10);
  expect(third.every(r => r.url.includes("window=7d") && !r.signal.aborted)).toBe(true);
  rerender({ view: "overview", window: "7d" });
  await waitFor(() => expect(third.filter(r => !r.url.includes("/usage/breakdown?")).every(r => r.signal.aborted)).toBe(true));
  expect(third.find(r => r.url.includes("/usage/breakdown?"))?.signal.aborted).toBe(false);
  unmount();
  expect(requests.every(r => r.signal.aborted)).toBe(true);
});

it("keeps an in-flight request while another observer still needs it", async () => {
  const { rerender } = renderHook(({ enabled }) => {
    useProxySettings({ enabled });
    useProxySettings();
  }, { initialProps: { enabled: true }, wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  rerender({ enabled: false });
  expect(requests[0].signal.aborted).toBe(false);
});
