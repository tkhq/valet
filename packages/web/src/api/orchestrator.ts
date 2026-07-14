/**
 * Assistant identity + children queries (assistant-centered web UI,
 * decisions 4/6). House pattern: a query-key factory per resource file,
 * mirroring `~/api/queries`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkOrchestrator = {
  info: () => ["orchestrator", "info"] as const,
  children: () => ["orchestrator", "children"] as const,
};

export function useOrchestratorInfo(opts?: UseQueryOptions<GetOrchestratorInfoResponse>) {
  return useQuery<GetOrchestratorInfoResponse>({
    queryKey: qkOrchestrator.info(),
    queryFn: () => api.getOrchestratorInfo(),
    ...opts,
  });
}

export function useOrchestratorChildren(
  opts?: UseQueryOptions<GetOrchestratorChildrenResponse>,
) {
  return useQuery<GetOrchestratorChildrenResponse>({
    queryKey: qkOrchestrator.children(),
    queryFn: () => api.getOrchestratorChildren(),
    ...opts,
  });
}

/**
 * Identity step's Start/Save action (decision 20): `PATCH /info` then
 * `POST /orchestrator` (ensure) — PATCH works before the engine session
 * exists (identity row upserts on PATCH if absent), ensure makes the id
 * resolvable by the rest of the app (session row, sandbox-less wake).
 * Shared by the onboarding step and the header's inline edit reopen — both
 * go through the same two-call sequence.
 */
export function useSaveIdentity() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { name: string; personality?: string }>({
    mutationFn: async (body) => {
      await api.patchOrchestratorInfo(body);
      await api.ensureOrchestrator();
      return { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.info() });
    },
  });
}
