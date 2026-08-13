// @vitest-environment jsdom
/**
 * The policy is the product decision here, so it is tested twice: once as
 * the pure function that decides the interval, and once through a real
 * `QueryClient` to prove the decision actually reaches the observer. A
 * wrapper that computes the right number but never wires it to the query
 * is the failure mode worth catching.
 *
 * These tests drive the clock themselves and never call `waitFor`. Testing
 * Library detects jest's fake timers, not vitest's, so its polling loop
 * waits on a clock that only `vi.advanceTimersByTimeAsync` moves — the test
 * deadlocks until the 5s timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { LIVE_POLL_MS, livePollInterval, useLiveQuery } from "./use-live-query";

interface Payload {
  rows: { done: boolean }[];
}

const anyRunning = (data: Payload) => data.rows.some((row) => !row.done);

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Runs every pending timer callback and every promise they resolve. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("livePollInterval", () => {
  it("does not schedule a poll before the first response lands", () => {
    expect(livePollInterval<Payload>(undefined, anyRunning, 1000)).toBe(false);
  });

  it("polls at the given period while a row is still running", () => {
    expect(livePollInterval({ rows: [{ done: true }, { done: false }] }, anyRunning, 1000)).toBe(
      1000,
    );
  });

  it("stops entirely once nothing is running", () => {
    expect(livePollInterval({ rows: [{ done: true }] }, anyRunning, 1000)).toBe(false);
  });

  it("treats an empty list as nothing to poll for", () => {
    expect(livePollInterval({ rows: [] }, anyRunning, 1000)).toBe(false);
  });

  it("defaults to a five second period", () => {
    expect(LIVE_POLL_MS).toBe(5_000);
  });
});

describe("useLiveQuery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
  });

  it("refetches while the data says work is in flight", async () => {
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ done: false }] });

    renderHook(
      () =>
        useLiveQuery<Payload>({
          queryKey: ["live-rows"],
          queryFn,
          isLive: anyRunning,
          intervalMs: 1000,
        }),
      { wrapper: makeWrapper(client) },
    );

    await advance(0);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await advance(3200);
    expect(queryFn.mock.calls.length).toBeGreaterThan(1);
    client.clear();
  });

  it("sends no request at all once nothing is in flight", async () => {
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ done: true }] });

    renderHook(
      () =>
        useLiveQuery<Payload>({
          queryKey: ["idle-rows"],
          queryFn,
          isLive: anyRunning,
          intervalMs: 1000,
        }),
      { wrapper: makeWrapper(client) },
    );

    await advance(0);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await advance(60_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("refetches an idle list when the user comes back to the tab", async () => {
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ done: true }] });

    renderHook(
      () =>
        useLiveQuery<Payload>({
          queryKey: ["focus-rows"],
          queryFn,
          isLive: anyRunning,
          intervalMs: 1000,
        }),
      { wrapper: makeWrapper(client) },
    );

    await advance(0);
    expect(queryFn).toHaveBeenCalledTimes(1);

    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await advance(0);

    expect(queryFn).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it("keeps the policy even when a caller passes its own interval", async () => {
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ done: true }] });

    renderHook(
      () =>
        useLiveQuery<Payload>({
          queryKey: ["override-rows"],
          queryFn,
          isLive: anyRunning,
          // A caller cannot reinstate a blind poll on a finished list.
          refetchInterval: 100,
        }),
      { wrapper: makeWrapper(client) },
    );

    await advance(0);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await advance(5_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
