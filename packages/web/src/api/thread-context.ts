/** How full a thread's model context is (`GET /api/threads/:threadId/context`). */
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export const qkThreadContext = {
  /** Prefix for every thread of one session. `api/ws.ts` invalidates it when a turn, compaction, or model switch changes the reading. */
  session: (sessionId: string) => ["thread-context", sessionId] as const,
  thread: (sessionId: string, threadId: string) => ["thread-context", sessionId, threadId] as const,
};

export function useThreadContext(sessionId: string, threadId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: threadId ? qkThreadContext.thread(sessionId, threadId) : ["thread-context", sessionId, "pending"],
    queryFn: () => threadId ? api.getThreadContext(threadId) : Promise.reject(new Error("No thread selected.")),
    enabled: enabled && threadId !== undefined,
    // The reading changes only at the events that invalidate it.
    staleTime: Infinity,
  });
}
