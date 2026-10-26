import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ChildWorkResponse } from "@valet/api/wire";
import { api } from "./client";

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
