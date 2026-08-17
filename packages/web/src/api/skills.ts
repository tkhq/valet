/**
 * Skill catalog queries and stored-skill mutations. House pattern: a
 * query-key factory per resource file, mirroring `~/api/workflows` /
 * `~/api/sources`.
 *
 * The catalog mixes two sources. Plugin skills change only when the server's
 * plugin set changes; stored skills change whenever someone writes one — from
 * this page, from an agent action, or from a repository sync — so every
 * mutation below invalidates the whole `["skills"]` subtree. A write can also
 * change which skills are shadowed, not just its own row.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  CreateSkillRequest,
  DeleteSkillResponse,
  GetSkillResponse,
  ListSkillsResponse,
  SkillResponse,
  UpdateSkillRequest,
} from "@valet/api/wire";
import { api, type SkillListQuery } from "./client";

export const qkSkills = {
  all: () => ["skills"] as const,
  list: (query: SkillListQuery = {}) => ["skills", "list", query] as const,
  detail: (name: string) => ["skills", name] as const,
  stored: (id: string) => ["skills", "stored", id] as const,
};

/**
 * One page of the catalog. The filters and the cursor go to the server and
 * into the query key together, so paging or changing a filter reads a fresh
 * page instead of re-filtering the one already in hand. Every write below
 * invalidates the whole `["skills"]` subtree, which covers every page.
 */
export function useSkills(
  query: SkillListQuery = {},
  opts?: Partial<UseQueryOptions<ListSkillsResponse>>,
) {
  return useQuery<ListSkillsResponse>({
    queryKey: qkSkills.list(query),
    queryFn: () => api.listSkills(query),
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

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation<SkillResponse, Error, CreateSkillRequest>({
    mutationFn: (body) => api.createSkill(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSkills.all() });
    },
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation<SkillResponse, Error, { id: string; body: UpdateSkillRequest }>({
    mutationFn: ({ id, body }) => api.updateSkill(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSkills.all() });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation<DeleteSkillResponse, Error, string>({
    mutationFn: (id) => api.deleteSkill(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSkills.all() });
    },
  });
}
