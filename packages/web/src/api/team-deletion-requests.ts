import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitTeamDeletionRequest } from "@valet/api/wire";
import { api } from "./client";

export const deletionKeys = {
  all: (teamId: string) => ["team-deletion-requests", teamId] as const,
  targets: (teamId: string) => ["team-deletion-requests", teamId, "targets"] as const,
};
export function useTeamDeletionRequests(teamId: string) {
  return useQuery({ queryKey: deletionKeys.all(teamId), queryFn: () => api.listTeamDeletionRequests(teamId) });
}
export function useTeamDeletionTargets(teamId: string) {
  return useQuery({ queryKey: deletionKeys.targets(teamId), queryFn: () => api.listTeamDeletionTargets(teamId) });
}
export function useSubmitTeamDeletionRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: SubmitTeamDeletionRequest) => api.submitTeamDeletionRequest(teamId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: deletionKeys.all(teamId) }) });
}
export function useDecideTeamDeletionRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, decision, note }: { id: string; decision: "approve" | "decline" | "withdraw"; note?: string }) => api.decideTeamDeletionRequest(teamId, id, decision, note),
    // Approval can remove any registered team resource. Refresh active readers;
    // a refusal also changes lastRefusal on the pending request.
    onSettled: () => qc.invalidateQueries(),
  });
}
