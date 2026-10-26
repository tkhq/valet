import { useInfiniteQuery, useMutation, useQueries, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ChildWorkResponse, ChildWorkSummary, DecisionGate } from "@valet/api/wire";
import { api } from "./client";
import { qk } from "./queries";

/** How often a parent thread rereads its running children's open requests. */
const CHILD_GATE_POLL_MS = 5_000;

export const childWorkKey = (sessionId: string | undefined) => ["child-work", sessionId] as const;

export function flattenChildWork(data: InfiniteData<ChildWorkResponse> | undefined) {
  return [...new Map(data?.pages.flatMap(page => page.children).map(child => [child.sessionId, child])).values()];
}

export function useChildWork(sessionId: string | undefined, opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useInfiniteQuery({
    queryKey: childWorkKey(sessionId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (!sessionId) throw new Error("Choose a parent session.");
      return api.getChildWork(sessionId, { cursor: pageParam });
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: opts?.refetchInterval ?? 30_000,
    enabled: !!sessionId && opts?.enabled !== false,
  });
}

/** The row leaves at once; a failed dismiss puts the list back. */
export function useDismissChild(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (childSessionId: string) => {
      if (!sessionId) throw new Error("Choose a parent session.");
      return api.dismissChild(sessionId, childSessionId);
    },
    onMutate: async (childSessionId: string) => {
      await qc.cancelQueries({ queryKey: childWorkKey(sessionId) });
      const previous = qc.getQueryData<InfiniteData<ChildWorkResponse>>(childWorkKey(sessionId));
      if (previous) qc.setQueryData<InfiniteData<ChildWorkResponse>>(childWorkKey(sessionId), {
        ...previous, pages: previous.pages.map(page => ({ ...page, children: page.children.filter(child => child.sessionId !== childSessionId) })),
      });
      return { previous };
    },
    onError: (_error, _childSessionId, context) => {
      if (context?.previous) qc.setQueryData(childWorkKey(sessionId), context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: childWorkKey(sessionId) }),
  });
}

/**
 * The open requests of a thread's running children, so the parent thread can
 * show and answer them. Nobody watches a child's own conversation. The query
 * key is the child's decisions key, so answering a card clears it at once.
 */
export function useChildGates(children: readonly ChildWorkSummary[], threadId: string | undefined): Array<{ child: ChildWorkSummary; gate: DecisionGate }> {
  const running = threadId ? children.filter(child => child.status === "running" && child.parentThreadId === threadId) : [];
  const results = useQueries({
    queries: running.map(child => ({
      queryKey: qk.decisions(child.sessionId),
      queryFn: () => api.listDecisions(child.sessionId),
      refetchInterval: CHILD_GATE_POLL_MS,
    })),
  });
  return running.flatMap((child, index) =>
    (results[index]?.data?.gates ?? []).filter(gate => gate.status === "pending").map(gate => ({ child, gate })));
}
