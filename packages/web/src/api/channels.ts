/** Channels a workspace talks and listens in. */
import { useQuery } from "@tanstack/react-query";
import { api, type OwnerFilter } from "./client";

export const qkChannels = {
  all: ["channels"] as const,
  list: (owner: OwnerFilter) => ["channels", "list", owner.ownerType, owner.ownerId] as const,
  thread: (sessionId: string, threadId: string) => ["channels", "thread", sessionId, threadId] as const,
};

export function useWorkspaceChannels(owner: OwnerFilter | undefined) {
  return useQuery({
    queryKey: owner ? qkChannels.list(owner) : ["channels", "list", "pending"],
    queryFn: () => owner ? api.listWorkspaceChannels(owner) : Promise.reject(new Error("No workspace selected.")),
    enabled: owner !== undefined,
    staleTime: 30_000,
  });
}

export function useThreadChannelActivity(sessionId: string, threadId: string, enabled = true) {
  return useQuery({
    queryKey: qkChannels.thread(sessionId, threadId),
    queryFn: () => api.getThreadChannelActivity(threadId),
    enabled,
    refetchInterval: 15_000,
  });
}
