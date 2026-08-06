/**
 * Skill catalog queries. House pattern: a query-key factory per resource
 * file, mirroring `~/api/workflows` / `~/api/integrations`.
 *
 * Reads only. Skills come from the installed plugin set, so the list can
 * change only when the server's plugin set changes — there is no mutation
 * surface and nothing to invalidate.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetSkillResponse, ListSkillsResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkSkills = {
  list: () => ["skills"] as const,
  detail: (name: string) => ["skills", name] as const,
};

export function useSkills(opts?: Partial<UseQueryOptions<ListSkillsResponse>>) {
  return useQuery<ListSkillsResponse>({
    queryKey: qkSkills.list(),
    queryFn: () => api.listSkills(),
    ...opts,
  });
}

export function useSkill(name: string, opts?: Partial<UseQueryOptions<GetSkillResponse>>) {
  return useQuery<GetSkillResponse>({
    queryKey: qkSkills.detail(name),
    queryFn: () => api.getSkill(name),
    enabled: !!name,
    ...opts,
  });
}
