/** Channels a workspace talks and listens in (docs/specs/2026-09-30-channels-design.md). */
import { useQuery } from "@tanstack/react-query";
import { api, type OwnerFilter } from "./client";

export const qkChannels = {
  all: ["channels"] as const,
  list: (owner: OwnerFilter) => ["channels", "list", owner.ownerType, owner.ownerId] as const,
  detail: (owner: OwnerFilter, key: string) => ["channels", "detail", owner.ownerType, owner.ownerId, key] as const,
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

export function useWorkspaceChannel(owner: OwnerFilter | undefined, key: string) {
  return useQuery({
    queryKey: owner ? qkChannels.detail(owner, key) : ["channels", "detail", "pending", key],
    queryFn: () => owner ? api.getWorkspaceChannel(owner, key) : Promise.reject(new Error("No workspace selected.")),
    enabled: owner !== undefined && key !== "",
    refetchInterval: 15_000,
  });
}

export function useThreadChannelMessages(sessionId: string, threadId: string, enabled = true) {
  return useQuery({
    queryKey: qkChannels.thread(sessionId, threadId),
    queryFn: () => api.listThreadChannelMessages(sessionId, threadId),
    enabled,
    refetchInterval: 15_000,
  });
}
