import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DismissWorkspaceBriefingResponse, WaitingThreadsResponse, WorkspaceBriefing } from "@valet/api/wire";
import { api, type OwnerFilter } from "./client";

export const qkCatchUp = {
  briefings: (owner: OwnerFilter) => ["workspace-briefings", owner.ownerType, owner.ownerId] as const,
  active: (owner: OwnerFilter) => ["workspace-active-work", owner.ownerType, owner.ownerId] as const,
  waiting: (owner: OwnerFilter) => ["workspace-waiting", owner.ownerType, owner.ownerId] as const,
  outcomes: (owner: OwnerFilter) => ["workspace-outcomes", owner.ownerType, owner.ownerId] as const,
  workArtifacts: (owner: OwnerFilter, sessionId: string, threadId?: string) =>
    ["artifacts", "work", owner.ownerType, owner.ownerId, sessionId, threadId] as const,
};

export function useWorkspaceOutcomes(owner: OwnerFilter) {
  return useInfiniteQuery({
    queryKey: qkCatchUp.outcomes(owner),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWorkspaceOutcomes(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useWorkspaceActiveWork(owner: OwnerFilter) {
  return useInfiniteQuery({
    queryKey: qkCatchUp.active(owner),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWorkspaceActiveWork(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

/** Threads whose newest agent message came after the last human action. */
export function useWaitingThreads(owner: OwnerFilter) {
  return useQuery({
    queryKey: qkCatchUp.waiting(owner),
    queryFn: () => api.getWaitingThreads(owner),
    refetchInterval: 10_000,
  });
}

/** Marks a waiting thread done by archiving it. It leaves the list at once. */
export function useFinishWaitingThread(owner: OwnerFilter) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (thread: { sessionId: string; threadId: string }) => api.patchThread(thread.sessionId, thread.threadId, { archived: true }),
    onMutate: (thread) => {
      qc.setQueryData<WaitingThreadsResponse>(qkCatchUp.waiting(owner), (current) => current && ({
        threads: current.threads.filter((row) => row.threadId !== thread.threadId),
      }));
    },
    onSettled: (_result, _error, thread) => {
      void qc.invalidateQueries({ queryKey: qkCatchUp.waiting(owner) });
      void qc.invalidateQueries({ queryKey: ["sessions", thread.sessionId, "threads"] });
    },
  });
}

export function useWorkspaceBriefings(owner: OwnerFilter) {
  return useQuery({
    queryKey: qkCatchUp.briefings(owner),
    queryFn: () => api.getWorkspaceBriefings(owner),
    staleTime: 60_000,
    refetchInterval: query => query.state.data?.refreshing ? 2_000 : 60_000,
  });
}

/** Dismisses a brief for the caller and archives its threads. */
export function useDismissBriefing(owner: OwnerFilter) {
  const qc = useQueryClient();
  return useMutation<DismissWorkspaceBriefingResponse, Error, WorkspaceBriefing>({
    mutationFn: (briefing) => api.dismissWorkspaceBriefing(owner, briefing.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkCatchUp.briefings(owner) });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
