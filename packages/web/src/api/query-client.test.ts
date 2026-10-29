import { MutationObserver, onlineManager, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error";
import { reportServerUnavailable, useApiConnection } from "./connection";
import { createQueryClient } from "./query-client";

// The test setup stubs the outage report for every other file (src/test/setup.ts).
vi.unmock("~/api/connection");

describe("the app query client across an api restart", () => {
  let healthy: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    healthy = false;
    vi.stubGlobal("fetch", vi.fn(async () => (healthy ? new Response("{}", { status: 200 }) : Promise.reject(new TypeError("Failed to fetch")))));
    useApiConnection.setState({ status: "online" });
    onlineManager.setOnline(true);
  });

  afterEach(async () => {
    healthy = true;
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    onlineManager.setOnline(true);
  });

  it("keeps a panel's data and shows no error while the api is down, then refetches when it returns", async () => {
    const client = createQueryClient();
    // `QueryClientProvider` mounts the client in the app: it then hears online events.
    client.mount();
    let down = false;
    const queryFn = vi.fn(async () => {
      if (down) {
        // What `request()` does with a gateway's 503: report it, then throw.
        reportServerUnavailable();
        throw new ApiError(503, "GET /api/threads → 503", "<html>Service Unavailable</html>");
      }
      return { threads: queryFn.mock.calls.length };
    });
    // `retry: false`, like the thread list: the outage rule still applies.
    const observer = new QueryObserver(client, { queryKey: ["threads"], queryFn, retry: false });
    const states: string[] = [];
    const stop = observer.subscribe((result) => states.push(result.status));
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual({ threads: 1 });
    // `useQuery` passes its options again on the render that shows the data.
    observer.setOptions({ queryKey: ["threads"], queryFn, retry: false });

    down = true;
    void observer.refetch();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(useApiConnection.getState().status).toBe("reconnecting");
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", data: { threads: 1 }, error: null });
    // Paused while the api is down: one try, then no more requests.
    const triesWhileDown = queryFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(queryFn.mock.calls.length).toBe(triesWhileDown);

    down = false;
    healthy = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(useApiConnection.getState().status).toBe("online");
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", error: null });
    expect(observer.getCurrentResult().data).not.toEqual({ threads: 1 });
    expect(states).not.toContain("error");
    stop();
    client.unmount();
  });

  it("keeps a query that has no data loading during an outage, not empty", async () => {
    const client = createQueryClient();
    client.mount();
    reportServerUnavailable();
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnection.getState().status).toBe("reconnecting");

    let up = false;
    const queryFn = vi.fn(async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return { connections: [] };
    });
    // Mounted for the first time while the api is down, like a newly opened page.
    const observer = new QueryObserver(client, { queryKey: ["team-credentials"], queryFn, retry: false });
    const stop = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer.getCurrentResult()).toMatchObject({ isLoading: true, data: undefined, error: null });

    up = true;
    healthy = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", data: { connections: [] } });
    stop();
    client.unmount();
  });

  it("shows a real api error at once, as before", async () => {
    healthy = true;
    const client = createQueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["broken"],
      queryFn: () => Promise.reject(new ApiError(500, "GET /api/broken → 500", { error: "boom" })),
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().status).toBe("error");
    stop();
  });

  it("fails a mutation at once while TanStack is offline, so the view can say why", async () => {
    onlineManager.setOnline(false);
    const observer = new MutationObserver(createQueryClient(), {
      mutationFn: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const settled = observer.mutate().then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("Failed to fetch");
  });
});
