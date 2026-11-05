/** The checklist the model keeps with `update_plan` (`GET /api/threads/:threadId/plan`). */
import { skipToken, useQuery } from "@tanstack/react-query";
import { api } from "./client";

/** `api/ws.ts` invalidates this key when an `update_plan` call ends. */
export const qkThreadPlan = (threadId: string | undefined) => ["thread-plan", threadId] as const;

export function useThreadPlan(threadId?: string) {
  return useQuery({
    queryKey: qkThreadPlan(threadId),
    queryFn: threadId ? () => api.getThreadPlan(threadId) : skipToken,
    // Only an `update_plan` call changes the plan, and its tool_end refreshes it.
    staleTime: Infinity,
  });
}
