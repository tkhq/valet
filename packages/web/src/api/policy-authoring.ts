import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export const qkPolicyAuthoring = {
  contexts: (teamId?: string) => ["policy-authoring", teamId ?? "org", "contexts"] as const,
};

export function usePolicyDraftContexts(teamId?: string) {
  return useQuery({
    queryKey: qkPolicyAuthoring.contexts(teamId),
    queryFn: () => api.getPolicyDraftContexts(teamId),
    staleTime: 60_000,
  });
}
