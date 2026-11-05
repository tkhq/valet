import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./client";

/** Fetch the selected version from newest page to oldest page. */
export function useBranchPreview(threadId: string | undefined, noteEntryId: string) {
  return useInfiniteQuery({
    queryKey: ["thread-branch-preview", threadId, noteEntryId],
    initialPageParam: "",
    queryFn: ({ pageParam }) => threadId
      ? api.branchPreview(threadId, noteEntryId, pageParam || undefined)
      : Promise.reject(new Error("No thread selected.")),
    getNextPageParam: (page) => page.hasMore ? page.nextCursor : undefined,
    enabled: !!threadId,
    staleTime: 0,
  });
}
