import { onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error";
import {
  backoffDelay,
  installConnection,
  REFETCH_SPREAD_MS,
  UNREACHABLE_AFTER_MS,
  isServerUnavailable,
  reportServerReachable,
  reportServerUnavailable,
  retryThroughOutage,
  useApiConnection,
  waitForOutageEnd,
} from "./connection";

// The test setup stubs the outage report for every other file (src/test/setup.ts).
vi.unmock("~/api/connection");

const gateway503 = () => new ApiError(503, "GET /api/sessions → 503", "<html>Service Unavailable</html>");

describe("isServerUnavailable", () => {
  it("counts no response and a gateway's non-JSON answer as an outage", () => {
    expect(isServerUnavailable(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isServerUnavailable(new ApiError(status, "x", "upstream connect error"))).toBe(true);
    }
  });

  it("keeps the api's own errors real, including its JSON 502/503", () => {
    expect(isServerUnavailable(new ApiError(503, "x", { error: "Registry is at capacity. Try again later." }))).toBe(false);
    expect(isServerUnavailable(new ApiError(502, "x", { error: "Team 1Password discovery failed." }))).toBe(false);
    expect(isServerUnavailable(new ApiError(500, "x", "Internal Server Error"))).toBe(false);
    expect(isServerUnavailable(new ApiError(404, "x", { error: "not found" }))).toBe(false);
    // The 30 s client timeout: the api is up but slow, and a retry would wait 30 s again.
    expect(isServerUnavailable(new ApiError(0, "got no response in 30s"))).toBe(false);
    expect(isServerUnavailable(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("doubles from 500 ms to an 8 s cap and adds at most 25 % jitter", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map((n) => backoffDelay(n, () => 0))).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    expect(backoffDelay(1, () => 0.999_999)).toBe(625);
    expect(backoffDelay(9, () => 0.999_999)).toBe(10_000);
  });
});

describe("retryThroughOutage", () => {
  beforeEach(() => useApiConnection.setState({ status: "online" }));

  it("follows the query's own rule for a real error", () => {
    const real = new ApiError(500, "x", { error: "boom" });
    expect(retryThroughOutage(false)(0, real)).toBe(false);
    expect(retryThroughOutage(1)(0, real)).toBe(true);
    expect(retryThroughOutage(1)(1, real)).toBe(false);
    expect(retryThroughOutage((count: number) => count < 2)(1, real)).toBe(true);
  });

  it("retries an outage failure three times while the api passes its health check", () => {
    const retry = retryThroughOutage(false);
    expect([0, 1, 2, 3].map((count) => retry(count, gateway503()))).toEqual([true, true, true, false]);
  });

  it("retries an outage failure without a cap while the api is down", () => {
    useApiConnection.setState({ status: "reconnecting" });
    expect(retryThroughOutage(false)(40, gateway503())).toBe(true);
  });
});

describe("the health probe", () => {
  let client: QueryClient;
  let healthy: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    healthy = false;
    vi.stubGlobal("fetch", vi.fn(async () => (healthy ? new Response("{}", { status: 200 }) : Promise.reject(new TypeError("Failed to fetch")))));
    client = new QueryClient();
    installConnection(client);
    useApiConnection.setState({ status: "online", unreachable: false });
    onlineManager.setOnline(true);
  });

  afterEach(async () => {
    // Let a probe that still waits finish, so the next test starts clean.
    healthy = true;
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    onlineManager.setOnline(true);
  });

  it("marks the api reconnecting, takes queries offline, and refetches every query when the api returns", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    reportServerUnavailable();
    expect(useApiConnection.getState().status).toBe("checking");
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnection.getState().status).toBe("reconnecting");
    expect(onlineManager.isOnline()).toBe(false);

    // A second report while the probe runs starts no second probe.
    reportServerUnavailable();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(invalidate).not.toHaveBeenCalled();

    healthy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useApiConnection.getState().status).toBe("online");
    // The refetch waits a random share of REFETCH_SPREAD_MS.
    await vi.advanceTimersByTimeAsync(REFETCH_SPREAD_MS);
    expect(onlineManager.isOnline()).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("leaves the app online when the probe passes at once, because the api answered for itself", async () => {
    healthy = true;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const signal = new AbortController().signal;
    reportServerUnavailable();
    const ended = waitForOutageEnd(signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnection.getState().status).toBe("online");
    expect(onlineManager.isOnline()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    await expect(ended).resolves.toBe(false);
  });

  it("tells a loop to start again when a confirmed outage ends", async () => {
    reportServerUnavailable();
    const ended = waitForOutageEnd(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    healthy = true;
    await vi.advanceTimersByTimeAsync(500);
    await expect(ended).resolves.toBe(true);
  });

  it("recovers at once when a session socket reconnects, and stops the probe", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    reportServerUnavailable();
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnection.getState().status).toBe("reconnecting");

    reportServerReachable();
    expect(useApiConnection.getState().status).toBe("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(onlineManager.isOnline()).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches nothing when a socket reconnects while the api still answered", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    healthy = true;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      reportServerUnavailable();
      reportServerReachable();
      await vi.advanceTimersByTimeAsync(REFETCH_SPREAD_MS);
    }
    expect(useApiConnection.getState().status).toBe("online");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says the api is unreachable after 90 s of failed probes and keeps probing", async () => {
    reportServerUnavailable();
    await vi.advanceTimersByTimeAsync(UNREACHABLE_AFTER_MS - 10_000);
    expect(useApiConnection.getState()).toMatchObject({ status: "reconnecting", unreachable: false });
    // The next failed probe after 90 s flips it. Probes run at most 8 s apart.
    await vi.advanceTimersByTimeAsync(18_000);
    expect(useApiConnection.getState()).toMatchObject({ status: "reconnecting", unreachable: true });
    const probes = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(probes);

    healthy = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(useApiConnection.getState()).toMatchObject({ status: "online", unreachable: false });
  });

  it("waits a random 0 to 2 s before the refetch, and recovers once for several reports", async () => {
    vi.mocked(Math.random).mockReturnValue(0.75);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    reportServerUnavailable();
    await vi.advanceTimersByTimeAsync(0);
    healthy = true;
    // The first probe retry waits 500 ms plus 25 % jitter at random 0.75.
    await vi.advanceTimersByTimeAsync(594);
    expect(useApiConnection.getState().status).toBe("online");
    reportServerReachable();
    await vi.advanceTimersByTimeAsync(0.75 * REFETCH_SPREAD_MS - 1);
    expect(onlineManager.isOnline()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onlineManager.isOnline()).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
