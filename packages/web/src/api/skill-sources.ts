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
import { api } from "./client";
import { qkSkills } from "./skills";

export const qkSkillSources = {
  list: () => ["skill-sources"] as const,
};

export function useSkillSources(opts?: Partial<UseQueryOptions<ListSkillSourcesResponse>>) {
  return useQuery<ListSkillSourcesResponse>({
    queryKey: qkSkillSources.list(),
    queryFn: () => api.listSkillSources(),
    ...opts,
  });
}

/** Invalidates the source list and the skill catalog together. */
function useSourceInvalidation(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qkSkillSources.list() });
    void qc.invalidateQueries({ queryKey: qkSkills.list() });
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
