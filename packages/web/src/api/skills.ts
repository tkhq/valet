/**
 * Skill catalog queries. House pattern: a query-key factory per resource
 * file, mirroring `~/api/workflows` / `~/api/sources`.
 *
 * Reads only. The web Skills tab browses the catalog; a skill is written in
 * the repository it comes from or by an agent through the `skills` actions
 * (docs/specs/2026-08-05-agent-skills-design.md), so nothing here mutates.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetSkillResponse, ListSkillsResponse, SkillResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkSkills = {
  list: () => ["skills"] as const,
  detail: (name: string) => ["skills", name] as const,
  stored: (id: string) => ["skills", "stored", id] as const,
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

/**
 * One stored skill with its body, by row id. The id, not the name: a
 * shadowed skill shares its name with the skill that shadows it, so only the
 * id reaches it. Pass null to hold the request.
 */
export function useStoredSkill(id: string | null, opts?: Partial<UseQueryOptions<SkillResponse>>) {
  return useQuery<SkillResponse>({
    queryKey: qkSkills.stored(id ?? ""),
    queryFn: () => api.getStoredSkill(id ?? ""),
    enabled: !!id,
    ...opts,
  });
}
