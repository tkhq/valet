/**
 * Artifact queries + mutations (artifacts design). House pattern: one
 * query-key factory per resource file, mirroring `~/api/memory`.
 *
 * The share/list/manage half is authed; `useArtifact` is the public
 * token-addressed read the `/a/$token` page uses.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  AddArtifactCommentRequest,
  AddArtifactCommentResponse,
  ArtifactEditorResponse,
  RequestArtifactEditRequest,
  RequestArtifactEditResponse,
  RestoreArtifactRequest,
  GetArtifactResponse,
  ListArtifactCommentsResponse,
  ListArtifactsResponse,
  ListArtifactVersionsResponse,
  PatchArtifactRequest,
  ShareArtifactResponse,
} from "@valet/api/wire";
import { api, ApiError, type OwnerFilter } from "./client";

export const qkArtifacts = {
  all: () => ["artifacts"] as const,
  // `mine` gets its own key segment (not folded into the owner tuple — it
  // composes with no owner) so the caller-scoped gallery view and an
  // unfiltered/team-owned list cache separately instead of colliding.
  list: (owner?: OwnerFilter, mine?: boolean, page?: { limit?: number; cursor?: string }) =>
    [
      "artifacts",
      "list",
      ...(owner ? [owner.ownerType, owner.ownerId] : []),
      ...(mine ? ["mine"] : []),
      ...(page ? [page.limit, page.cursor] : []),
    ] as const,
  byToken: (token: string) => ["artifacts", "token", token] as const,
  comments: (token: string) => ["artifacts", "comments", token] as const,
  versions: (id: string) => ["artifacts", "versions", id] as const,
  editor: (id: string, version?: number) => ["artifacts", "editor", id, version ?? "latest"] as const,
};

export function useArtifactEditor(id: string, version?: number) {
  const qc = useQueryClient();
  const query = useQuery<ArtifactEditorResponse>({
    queryKey: qkArtifacts.editor(id, version),
    queryFn: () => api.getArtifactEditor(id, version),
    enabled: !!id,
    retry: retryUnlessGoneOrSignedOut,
    refetchInterval: version === undefined ? 2_000 : false,
  });
  const workingVersion = query.data?.artifact.version;
  useEffect(() => {
    if (version === undefined && workingVersion !== undefined) {
      void qc.invalidateQueries({ queryKey: qkArtifacts.versions(id) });
    }
  }, [id, version, workingVersion, qc]);
  return query;
}

export function useRequestArtifactEdit(id: string) {
  const qc = useQueryClient();
  return useMutation<RequestArtifactEditResponse, Error, RequestArtifactEditRequest>({
    mutationFn: (body) => api.requestArtifactEdit(id, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qkArtifacts.all() }); },
  });
}

export function useRestoreArtifact(id: string) {
  const qc = useQueryClient();
  return useMutation<ArtifactEditorResponse, Error, RestoreArtifactRequest>({
    mutationFn: (body) => api.restoreArtifact(id, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qkArtifacts.all() }); },
  });
}

/** 404 (revoked or unknown) and 401 (sign-in required) are outcomes, not
 * transient failures. Anything else retries twice. */
function retryUnlessGoneOrSignedOut(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 404 || error.status === 401)) return false;
  return failureCount < 2;
}

export function useArtifact(token: string, opts?: Partial<UseQueryOptions<GetArtifactResponse>>) {
  return useQuery<GetArtifactResponse>({
    queryKey: qkArtifacts.byToken(token),
    queryFn: () => api.getArtifact(token),
    retry: retryUnlessGoneOrSignedOut,
    ...opts,
  });
}

export function useArtifacts(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListArtifactsResponse>> & { mine?: boolean; limit?: number; cursor?: string },
) {
  const { mine, limit, cursor, ...queryOpts } = opts ?? {};
  return useQuery<ListArtifactsResponse>({
    queryKey: qkArtifacts.list(owner, mine, limit !== undefined || cursor !== undefined ? { limit, cursor } : undefined),
    queryFn: () => api.listArtifacts(owner, { mine, limit, cursor }),
    ...queryOpts,
  });
}

export function useShareArtifact() {
  const qc = useQueryClient();
  return useMutation<ShareArtifactResponse, Error, { path: string }>({
    mutationFn: ({ path }) => api.shareArtifact({ path }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.list() });
    },
  });
}

export function usePatchArtifact() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string } & PatchArtifactRequest>({
    mutationFn: ({ id, ...body }) => api.patchArtifact(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.list() });
    },
  });
}

export function useArtifactVersions(id: string | undefined, opts?: { enabled?: boolean }) {
  return useQuery<ListArtifactVersionsResponse>({
    queryKey: qkArtifacts.versions(id ?? ""),
    queryFn: () => api.listArtifactVersions(id ?? ""),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

/** Comments on the public page. Enabled only for callers the read said may
 * comment — an anonymous reader's fetch would just 401. */
export function useArtifactComments(token: string, opts?: { enabled?: boolean }) {
  return useQuery<ListArtifactCommentsResponse>({
    queryKey: qkArtifacts.comments(token),
    queryFn: () => api.listArtifactComments(token),
    enabled: opts?.enabled ?? true,
    retry: retryUnlessGoneOrSignedOut,
  });
}

export function useAddArtifactComment(token: string) {
  const qc = useQueryClient();
  return useMutation<AddArtifactCommentResponse, Error, AddArtifactCommentRequest>({
    mutationFn: (body) => api.addArtifactComment(token, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.comments(token) });
    },
  });
}

export function useResolveArtifactComment(token: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { commentId: string }>({
    mutationFn: ({ commentId }) => api.resolveArtifactComment(token, commentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.comments(token) });
    },
  });
}

export function useRevokeArtifact() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string }>({
    mutationFn: ({ id }) => api.revokeArtifact(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.list() });
    },
  });
}
