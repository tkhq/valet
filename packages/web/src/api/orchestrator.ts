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

export function useOrchestratorInfo(
  opts?: Partial<UseQueryOptions<GetOrchestratorInfoResponse>>,
) {
  return useQuery<GetOrchestratorInfoResponse>({
    queryKey: qkOrchestrator.info(),
    queryFn: () => api.getOrchestratorInfo(),
    ...opts,
  });
}

export function useOrchestratorChildren(
  opts?: Partial<UseQueryOptions<GetOrchestratorChildrenResponse>>,
) {
  return useQuery<GetOrchestratorChildrenResponse>({
    queryKey: qkOrchestrator.children(),
    queryFn: () => api.getOrchestratorChildren(),
    ...opts,
  });
}

/** Dismiss a settled child from the thread tree. Display state only — the
 * child session and its history stay reachable from the Sessions page. */
export function useDismissChild() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (childSessionId) => api.dismissChild(childSessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.children() });
    },
  });
}

/**
 * `/chat`'s mount-time ensure (brief for Task 5): `GET /info` never
 * creates the engine session (decision 4), so an assistant that has a name
 * but was never `POST /orchestrator`-ensured (e.g. named via a future path
 * that skips the identity step's own ensure call) would 404 the moment the
 * chat page tries to open its session/WS. `POST /orchestrator` is
 * idempotent — safe to call on every chat mount.
 */
export function useEnsureOrchestrator() {
  const qc = useQueryClient();
  return useMutation<{ sessionId: string }, Error, void>({
    mutationFn: () => api.ensureOrchestrator(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.info() });
    },
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
