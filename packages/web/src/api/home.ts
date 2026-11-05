import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HomeTasksResponse } from "@valet/api/wire";
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

/** Marks a task started from home done. It leaves Tasks at once. */
export function useMarkHomeTaskDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.markHomeTaskDone(taskId),
    onMutate: (taskId) => {
      qc.setQueryData<HomeTasksResponse>(qkHome.tasks, (current) => current && ({
        ...current,
        finished: current.finished.filter((item) => item.homeTaskId !== taskId),
      }));
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: qkHome.tasks }); },
  });
}
