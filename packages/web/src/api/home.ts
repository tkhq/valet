import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DismissHomeTaskRequest, HomeTaskItem, HomeTasksResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkHome = {
  conversation: ["home", "conversation"] as const,
  tasks: ["home", "tasks"] as const,
};

/** The person's home conversation: one thread with Valet across every workspace. */
export function useHomeConversation(enabled = true) {
  return useQuery({
    queryKey: qkHome.conversation,
    queryFn: () => api.ensureHomeConversation(),
    staleTime: Infinity,
    enabled,
  });
}

/** Everything in flight across the person's workspaces. */
export function useHomeTasks(enabled = true) {
  return useQuery({
    queryKey: qkHome.tasks,
    queryFn: () => api.getHomeTasks(),
    refetchInterval: 10_000,
    enabled,
  });
}

/**
 * Crosses a thread out of Tasks: done, or no longer relevant. It leaves the
 * list at once and comes back only when it needs the person again. Running
 * work keeps running.
 */
export function useDismissHomeTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (thread: DismissHomeTaskRequest) => api.dismissHomeTask(thread),
    onMutate: (thread) => {
      const keep = (item: HomeTaskItem) => item.sessionId !== thread.sessionId || item.threadId !== thread.threadId;
      qc.setQueryData<HomeTasksResponse>(qkHome.tasks, (current) => current && ({
        needsYou: current.needsYou.filter(keep),
        working: current.working.filter(keep),
        finished: current.finished.filter(keep),
      }));
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: qkHome.tasks }); },
  });
}
