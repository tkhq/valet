// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApiAvailability } from "~/stores/api-availability";
import { ApiReconnectingBanner, BANNER_DELAY_MS, HEALTH_POLL_MS } from "./api-reconnecting-banner";

const health = (ok: boolean) =>
  ok
    ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    : new Response("<html>503</html>", { status: 503, headers: { "Content-Type": "text/html" } });

function mount(client = new QueryClient()) {
  return render(<QueryClientProvider client={client}><ApiReconnectingBanner /></QueryClientProvider>);
}

beforeEach(() => {
  vi.useFakeTimers();
  useApiAvailability.setState({ unavailableSince: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api reconnecting banner", () => {
  it("does not flash for a short drop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => health(false)));
    mount();
    act(() => useApiAvailability.getState().markUnavailable());
    await act(() => vi.advanceTimersByTimeAsync(BANNER_DELAY_MS - 100));
    act(() => useApiAvailability.getState().markAvailable());
    await act(() => vi.advanceTimersByTimeAsync(BANNER_DELAY_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows during an outage, clears on a healthy poll, and refetches failed queries", async () => {
    const fetchMock = vi.fn(async () => health(false));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    mount(client);
    act(() => useApiAvailability.getState().markUnavailable());
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS));
    expect(screen.getByRole("status").textContent).toBe("Lost connection to Valet. Reconnecting…");
    expect(useApiAvailability.getState().unavailableSince).not.toBeNull();

    fetchMock.mockImplementation(async () => health(true));
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS));
    expect(useApiAvailability.getState().unavailableSince).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
  });

  it("refetches failed queries when another request clears the outage before a poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => health(false)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["failed-during-outage"];
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue("fresh");
    await client.prefetchQuery({ queryKey, queryFn });
    expect(client.getQueryState(queryKey)?.status).toBe("error");
    mount(client);
    act(() => useApiAvailability.getState().markUnavailable());
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS - 500));
    // A retried GET succeeds before the next poll: request() marks the api available.
    act(() => useApiAvailability.getState().markAvailable());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(queryKey)).toBe("fresh");
  });

  it("does not poll while the api is available", async () => {
    const fetchMock = vi.fn(async () => health(true));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS * 3));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
