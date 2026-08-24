/**
 * Design-artifact queries + mutations (Valet Design spec). House pattern:
 * one query-key factory per resource file, mirroring `~/api/artifacts`.
 *
 * REST is the authoritative read path. The design.* WS frames carry
 * metadata only; the canvas watches the stream store and invalidates these
 * queries when a frame arrives (bytes never ride the wire).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  DesignArtifactResponse,
  DesignCommentsResponse,
  DesignExportsResponse,
  DesignRevisionsResponse,
  DesignTokensResponse,
  ListSessionsResponse,
} from "@valet/api/wire";
import { api, ApiError, type OwnerFilter } from "./client";

export const qkDesign = {
  /** The design hub's list — separate from `qk.sessions` because it holds a
   * kind-filtered answer the unfiltered key must never serve. */
  sessions: (owner?: OwnerFilter) =>
    ["design", "sessions", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  artifact: (sessionId: string) => ["design", sessionId, "artifact"] as const,
  revisions: (sessionId: string) => ["design", sessionId, "revisions"] as const,
  revision: (sessionId: string, rev: string) =>
    ["design", sessionId, "revisions", rev] as const,
  comments: (sessionId: string) => ["design", sessionId, "comments"] as const,
  tokens: (sessionId: string) => ["design", sessionId, "tokens"] as const,
  exports: (sessionId: string) => ["design", sessionId, "exports"] as const,
};

/** Design sessions only (`GET /api/sessions?kind=design`), for the hub. */
export function useDesignSessions(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListSessionsResponse>>,
) {
  return useQuery<ListSessionsResponse>({
    queryKey: qkDesign.sessions(owner),
    queryFn: () => api.listSessions(owner, { kind: "design" }),
    ...opts,
  });
}

export function useDesignArtifact(
  sessionId: string,
  opts?: Partial<UseQueryOptions<DesignArtifactResponse>>,
) {
  return useQuery<DesignArtifactResponse>({
    queryKey: qkDesign.artifact(sessionId),
    queryFn: () => api.getDesignArtifact(sessionId),
    enabled: !!sessionId,
    retry: (failureCount, error) => {
      // 404 = no artifact (not a design session, or pre-seed) — an outcome
      // the canvas renders an empty state for, not a transient failure.
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 2;
    },
    ...opts,
  });
}

export function useDesignRevisions(
  sessionId: string,
  opts?: Partial<UseQueryOptions<DesignRevisionsResponse>>,
) {
  return useQuery<DesignRevisionsResponse>({
    queryKey: qkDesign.revisions(sessionId),
    queryFn: () => api.listDesignRevisions(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

export function useDesignComments(
  sessionId: string,
  opts?: Partial<UseQueryOptions<DesignCommentsResponse>>,
) {
  return useQuery<DesignCommentsResponse>({
    queryKey: qkDesign.comments(sessionId),
    queryFn: () => api.listDesignComments(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

export function useDesignTokens(
  sessionId: string,
  opts?: Partial<UseQueryOptions<DesignTokensResponse>>,
) {
  return useQuery<DesignTokensResponse>({
    queryKey: qkDesign.tokens(sessionId),
    queryFn: () => api.getDesignTokens(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

/** Files the agent exported to the sandbox's /workspace/exports — the
 * Export modal's "Exported files" list. Polled while the modal is open so
 * an agent export that finishes mid-look appears without a reopen. */
export function useDesignExports(
  sessionId: string,
  opts?: Partial<UseQueryOptions<DesignExportsResponse>>,
) {
  return useQuery<DesignExportsResponse>({
    queryKey: qkDesign.exports(sessionId),
    queryFn: () => api.listDesignExports(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

/** POST /design/revert — appends a new revision copied from an old one.
 * The server emits `design.artifact.updated`, but this invalidates too so
 * the canvas refreshes even if the WS frame is dropped mid-handshake. */
export function useRevertRevision(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ revision: string; summary: string }, Error, { revision: string }>({
    mutationFn: ({ revision }) => api.revertDesignArtifact(sessionId, revision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkDesign.artifact(sessionId) });
      void qc.invalidateQueries({ queryKey: qkDesign.revisions(sessionId) });
    },
  });
}

export function useAddComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    { id: string; vdid: string; createdAt: number },
    Error,
    { vdid: string; body: string }
  >({
    mutationFn: (body) => api.addDesignComment(sessionId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkDesign.comments(sessionId) });
    },
  });
}
