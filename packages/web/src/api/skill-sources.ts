/**
 * Tracked skill repositories. House pattern: a query-key factory per
 * resource file, mirroring `~/api/skills` and `~/api/sources`.
 *
 * Every mutation invalidates the skill catalog as well as the source list,
 * because a sync writes skills — the grid on the same page must not keep
 * showing what the repository no longer holds.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  CreateSkillSourceRequest,
  DeleteSkillSourceResponse,
  ListSkillSourcesResponse,
  SkillSourceSummary,
  SkillSourceSyncResponse,
} from "@valet/api/wire";
import { api, type SkillSourceListQuery } from "./client";
import { qkSkills } from "./skills";

export const qkSkillSources = {
  all: () => ["skill-sources"] as const,
  list: (query: SkillSourceListQuery = {}) => ["skill-sources", "list", query] as const,
};

/** One page of tracked repositories. The owner pin and the cursor go into the
 * key, so every page is its own cache entry. */
export function useSkillSources(
  query: SkillSourceListQuery = {},
  opts?: Partial<UseQueryOptions<ListSkillSourcesResponse>>,
) {
  return useQuery<ListSkillSourcesResponse>({
    queryKey: qkSkillSources.list(query),
    queryFn: () => api.listSkillSources(query),
    ...opts,
  });
}

/** Invalidates every page of the source list and of the skill catalog
 * together: a sync writes skills, and a source added on page one shifts the
 * pages after it. */
function useSourceInvalidation(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qkSkillSources.all() });
    void qc.invalidateQueries({ queryKey: qkSkills.all() });
  };
}

export function useAddSkillSource() {
  const invalidate = useSourceInvalidation();
  return useMutation<SkillSourceSyncResponse, Error, CreateSkillSourceRequest>({
    mutationFn: (body) => api.createSkillSource(body),
    onSuccess: invalidate,
  });
}

export function useSyncSkillSource() {
  const invalidate = useSourceInvalidation();
  return useMutation<SkillSourceSyncResponse, Error, string>({
    mutationFn: (id) => api.syncSkillSource(id),
    onSuccess: invalidate,
  });
}

export function useRemoveSkillSource() {
  const invalidate = useSourceInvalidation();
  return useMutation<DeleteSkillSourceResponse, Error, string>({
    mutationFn: (id) => api.deleteSkillSource(id),
    onSuccess: invalidate,
  });
}

export type { SkillSourceSummary };
