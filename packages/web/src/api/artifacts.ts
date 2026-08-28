/**
 * Artifact queries + mutations (artifacts design). House pattern: one
 * query-key factory per resource file, mirroring `~/api/memory`.
 *
 * The share/list/manage half is authed; `useArtifact` is the public
 * token-addressed read the `/a/$token` page uses.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  GetArtifactResponse,
  ListArtifactsResponse,
  PatchArtifactRequest,
  ShareArtifactResponse,
} from "@valet/api/wire";
import { api, ApiError, type OwnerFilter } from "./client";

export const qkArtifacts = {
  list: (owner?: OwnerFilter) =>
    ["artifacts", "list", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  byToken: (token: string) => ["artifacts", "token", token] as const,
};

export function useArtifact(token: string, opts?: Partial<UseQueryOptions<GetArtifactResponse>>) {
  return useQuery<GetArtifactResponse>({
    queryKey: qkArtifacts.byToken(token),
    queryFn: () => api.getArtifact(token),
    retry: (failureCount, error) => {
      // 404 (revoked/unknown) and 401 (login required) are outcomes, not
      // transient failures.
      if (error instanceof ApiError && (error.status === 404 || error.status === 401)) return false;
      return failureCount < 2;
    },
    ...opts,
  });
}

export function useArtifacts(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListArtifactsResponse>>,
) {
  return useQuery<ListArtifactsResponse>({
    queryKey: qkArtifacts.list(owner),
    queryFn: () => api.listArtifacts(owner),
    ...opts,
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
    mutationFn: ({ id, visibility }) => api.patchArtifact(id, { visibility }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkArtifacts.list() });
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
