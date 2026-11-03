import { skipToken, useQuery } from "@tanstack/react-query";
import { api } from "./client";

export const qkThreadProgress = (threadId: string | undefined) => ["thread-progress", threadId] as const;

export function useThreadProgress(threadId?: string) {
  return useQuery({
    queryKey: qkThreadProgress(threadId),
    queryFn: threadId ? () => api.getThreadProgress(threadId) : skipToken,
    // The thread-targeted WebSocket invalidates snapshots for shared guests too.
    staleTime: Infinity,
  });
}
