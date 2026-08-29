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
  GetTeamChildrenResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
} from "@valet/api/wire";
import { api } from "./client";
import { qk } from "./queries";

export const qkOrchestrator = {
  info: () => ["orchestrator", "info"] as const,
  // Keyed by parent session so one assistant's children never overwrite
  // another's in the cache. Bare key stays for the caller's own default.
  children: (sessionId?: string) =>
    sessionId
      ? (["orchestrator", "children", sessionId] as const)
      : (["orchestrator", "children"] as const),
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

/** Children of one assistant session. `sessionId` is the OPEN assistant in
 * the thread tree, so a team assistant's runs nest under it; omitted reads the
 * caller's own default. */
export function useOrchestratorChildren(
  sessionId?: string,
  opts?: Partial<UseQueryOptions<GetOrchestratorChildrenResponse>>,
) {
  return useQuery<GetOrchestratorChildrenResponse>({
    queryKey: qkOrchestrator.children(sessionId),
    queryFn: () => api.getOrchestratorChildren(sessionId),
    ...opts,
  });
}

/** A team's assistant runs — the team mirror of `useOrchestratorChildren`
 * (team dashboard design). Runs move, so refetch on the same cadence the
 * personal children query uses. */
export function useTeamChildren(
  teamId: string,
  opts?: Partial<UseQueryOptions<GetTeamChildrenResponse>>,
) {
  return useQuery<GetTeamChildrenResponse>({
    queryKey: ["teams", teamId, "children"],
    queryFn: () => api.getTeamChildren(teamId),
    refetchInterval: 30_000,
    ...opts,
  });
}

/** Dismiss a settled child from the thread tree. Display state only — the
 * child session and its history stay reachable from the Sessions page.
 * `sessionId` is the parent whose children list to refresh, so a team
 * assistant's tree updates in place. */
export function useDismissChild(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (childSessionId) => api.dismissChild(childSessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.children(sessionId) });
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
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.info() });
      // `GET /info` reports a session id without creating the session, so on
      // a first-ever load the chat page mounts on that id and its read 404s
      // while this call is still in flight — the whole screen shows "Failed
      // to load session", on the one visit where a person has nothing else
      // to look at. Invalidating makes the read retry once the row exists,
      // rather than leaving a dead end that a manual reload fixes.
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
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
