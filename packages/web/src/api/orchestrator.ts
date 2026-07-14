/**
 * Assistant identity query (assistant-centered web UI, decision 4). House
 * pattern: a query-key factory per resource file, mirroring `~/api/queries`.
 * Task 4 extends this file with the `children` query.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetOrchestratorInfoResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkOrchestrator = {
  info: () => ["orchestrator", "info"] as const,
};

export function useOrchestratorInfo(opts?: UseQueryOptions<GetOrchestratorInfoResponse>) {
  return useQuery<GetOrchestratorInfoResponse>({
    queryKey: qkOrchestrator.info(),
    queryFn: () => api.getOrchestratorInfo(),
    ...opts,
  });
}
