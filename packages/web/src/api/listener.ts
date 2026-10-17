/**
 * Query hooks for one listener's page and one routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 4, Part D step 2):
 * the listener's deliveries and receipts, the title of a pinned thread, and
 * the titles of the threads deliveries reached.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  ListEventReceiptsResponse,
  ListSubscriptionDeliveriesResponse,
  ThreadSummary,
} from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import type { ThreadTitles } from "~/components/presence/sentences";
import { api } from "./client";

export const qkListener = {
  deliveries: (id: string) => ["events", "subscription-deliveries", id] as const,
  receipts: (id: string) => ["events", "receipts", "listener", id] as const,
  pinTitle: (sessionId: string, threadId: string) => ["presence", "pin-title", sessionId, threadId] as const,
  threadAddress: (threadId: string) => ["presence", "thread-address", threadId] as const,
};

/** One listener's latest deliveries, newest first, each with its event. */
export function useListenerDeliveries(id: string) {
  return useQuery<ListSubscriptionDeliveriesResponse>({
    queryKey: qkListener.deliveries(id),
    queryFn: () => api.listSubscriptionDeliveries(id, 25),
    refetchInterval: 30_000,
  });
}

/** One listener's receipts. Receipts are admin-only, so the caller enables
 * the read only for an organization administrator. */
export function useListenerReceipts(id: string, enabled: boolean) {
  return useQuery<ListEventReceiptsResponse>({
    queryKey: qkListener.receipts(id),
    queryFn: () => api.listEventReceipts({ subscriptionId: id, limit: 10 }),
    enabled,
  });
}

function findThread(threads: readonly ThreadSummary[], threadId: string): ThreadSummary | undefined {
  return threads.find((t) => t.id === threadId);
}

/**
 * The title of a pinned thread. The thread list leaves out archived threads,
 * and a pin that has a problem usually points at one, so a miss reads the
 * archived list next. Null when neither read returns the thread.
 */
export async function pinnedThreadTitle(sessionId: string, threadId: string): Promise<string | null> {
  const open = await api.listThreads(sessionId, { threadId });
  const found = findThread(open.threads, threadId)
    ?? findThread((await api.listThreads(sessionId, { threadId, archived: true })).threads, threadId);
  return found?.title ?? null;
}

/** The titles of pinned threads as `ThreadTitles`, for sentences. A pin
 * reads as untitled while it loads or when no read returns its thread. */
export function usePinnedThreadTitles(policies: ReadonlyArray<AssistantThreadPolicy | null | undefined>): ThreadTitles {
  const pins = new Map<string, Extract<AssistantThreadPolicy, { mode: "existing" }>>();
  for (const policy of policies) {
    if (policy?.mode === "existing") pins.set(policy.threadId, policy);
  }
  const ordered = [...pins.values()].sort((a, b) => a.threadId.localeCompare(b.threadId));
  const results = useQueries({
    queries: ordered.map((pin) => ({
      queryKey: qkListener.pinTitle(pin.sessionId, pin.threadId),
      queryFn: () => pinnedThreadTitle(pin.sessionId, pin.threadId),
      staleTime: 60_000,
    })),
  });
  const titles: Record<string, { title: string }> = {};
  results.forEach((result, index) => {
    const pin = ordered[index];
    if (pin && result.data) titles[pin.threadId] = { title: result.data };
  });
  return titles;
}

/** One pinned thread's title; see `usePinnedThreadTitles`. */
export function usePinnedThreadTitle(policy: AssistantThreadPolicy | null | undefined): ThreadTitles {
  return usePinnedThreadTitles([policy]);
}

/** The titles of the threads that deliveries reached or that claimed them,
 * one read per thread. A thread the viewer may not open reads as untitled. */
export function useThreadTitlesById(threadIds: readonly string[]): ThreadTitles {
  const unique = [...new Set(threadIds)].sort();
  const results = useQueries({
    queries: unique.map((threadId) => ({
      queryKey: qkListener.threadAddress(threadId),
      queryFn: () => api.getThreadAddress(threadId),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const titles: Record<string, { title: string | null | undefined }> = {};
  for (const result of results) {
    if (result.data) titles[result.data.id] = { title: result.data.title };
  }
  return titles;
}
