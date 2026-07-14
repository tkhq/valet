// @vitest-environment jsdom
/**
 * `useInvalidateMessagesOnQueueState` (Task 5 CRITICAL flag): a
 * `queue.state` frame for the assistant session should, after the debounce
 * window, invalidate the messages REST query for the active thread — the
 * only path that surfaces a signal (e.g. `child.settled`) delivered via
 * REST-only persistence into the live chat page. The debounce mechanics
 * themselves are covered directly in `~/lib/debounce.test.ts`; this test
 * covers the wiring: store event → invalidateQueries call.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useInvalidateMessagesOnQueueState } from "./use-invalidate-messages-on-queue-state";
import { useStreamStore } from "~/stores/stream";
import { qk } from "~/api/queries";

const SESSION = "orchestrator:user-1";
const THREAD = "thread-1";

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useInvalidateMessagesOnQueueState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStreamStore.setState({ bySession: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates the messages query after a debounced queue.state event", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    renderHook(() => useInvalidateMessagesOnQueueState(SESSION, THREAD), {
      wrapper: wrapper(qc),
    });

    expect(spy).not.toHaveBeenCalled();

    // Simulate the reducer's queue.state case: a fresh object identity.
    act(() => {
      useStreamStore.setState((s) => ({
        bySession: {
          ...s.bySession,
          [SESSION]: {
            ...(s.bySession[SESSION] ?? {
              conn: "open",
              lastOffset: "",
              agentStatus: "idle",
              messages: [],
              pendingGates: {},
            }),
            queueByThread: {
              [THREAD]: {
                mode: "followup",
                status: "idle",
                pendingIds: [],
                collectingIds: [],
              },
            },
          },
        },
      }));
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(spy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.messages(SESSION, THREAD) });
  });

  it("does nothing when no queue.state has arrived", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useInvalidateMessagesOnQueueState(SESSION, THREAD), {
      wrapper: wrapper(qc),
    });
    vi.advanceTimersByTime(5_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
