/**
 * TanStack Query hooks for the settings shell's data surface (split-settings
 * design, Task 5). Mirrors the factory idiom in `src/api/queries.ts`:
 * query-key factory object, one hook per read, mutations invalidate the
 * keys they affect. `/api/me`, `/api/org`, `/api/org/members`, `/api/models`
 * are the four reads; `/api/me`, `/api/org`, `/api/org/members/:userId` are
 * the three writes Tasks 6–7 wire up to actual controls.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  AddTeamMemberRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  ListModelsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  MeResponse,
  OrgMembersResponse,
  OrgResponse,
  PatchMeRequest,
  PatchMeResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgRequest,
  PatchOrgResponse,
  SetTeamMemberRoleRequest,
} from "@valet/api/wire";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qkSettings = {
  me: () => ["settings", "me"] as const,
  org: () => ["settings", "org"] as const,
  orgMembers: () => ["settings", "org", "members"] as const,
  models: () => ["settings", "models"] as const,
  teams: () => ["settings", "teams"] as const,
  teamMembers: (teamId: string) => ["settings", "teams", teamId, "members"] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

export function useMe(opts?: UseQueryOptions<MeResponse>) {
  return useQuery<MeResponse>({
    queryKey: qkSettings.me(),
    queryFn: () => api.getMe(),
    ...opts,
  });
}

export function useOrg(opts?: UseQueryOptions<OrgResponse>) {
  return useQuery<OrgResponse>({
    queryKey: qkSettings.org(),
    queryFn: () => api.getOrg(),
    ...opts,
  });
}

export function useOrgMembers(opts?: UseQueryOptions<OrgMembersResponse>) {
  return useQuery<OrgMembersResponse>({
    queryKey: qkSettings.orgMembers(),
    queryFn: () => api.getOrgMembers(),
    ...opts,
  });
}

export function useModels(opts?: UseQueryOptions<ListModelsResponse>) {
  return useQuery<ListModelsResponse>({
    queryKey: qkSettings.models(),
    queryFn: () => api.listModels(),
    // Static registry (pi-ai `getModels`, no provider call) — effectively
    // never changes within a session.
    staleTime: Infinity,
    ...opts,
  });
}

export function useTeams(opts?: UseQueryOptions<ListTeamsResponse>) {
  return useQuery<ListTeamsResponse>({
    queryKey: qkSettings.teams(),
    queryFn: () => api.listTeams(),
    ...opts,
  });
}

export function useTeamMembers(teamId: string, opts?: UseQueryOptions<ListTeamMembersResponse>) {
  return useQuery<ListTeamMembersResponse>({
    queryKey: qkSettings.teamMembers(teamId),
    queryFn: () => api.listTeamMembers(teamId),
    ...opts,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation<PatchMeResponse, Error, PatchMeRequest>({
    mutationFn: (body) => api.patchMe(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.me() });
    },
  });
}

export function usePatchOrg() {
  const qc = useQueryClient();
  return useMutation<PatchOrgResponse, Error, PatchOrgRequest>({
    mutationFn: (body) => api.patchOrg(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

export function useSetOrgMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    PatchOrgMemberResponse,
    Error,
    { userId: string; body: PatchOrgMemberRequest },
    { previous: OrgMembersResponse | undefined }
  >({
    mutationFn: ({ userId, body }) => api.patchOrgMember(userId, body),
    // Optimistic: the row flips immediately, then rolls back if the server
    // rejects it (e.g. the last-admin guard) — the UI disable on the sole
    // admin row is a courtesy, not the source of truth.
    onMutate: async ({ userId, body }) => {
      await qc.cancelQueries({ queryKey: qkSettings.orgMembers() });
      const previous = qc.getQueryData<OrgMembersResponse>(qkSettings.orgMembers());
      if (previous) {
        qc.setQueryData<OrgMembersResponse>(qkSettings.orgMembers(), {
          members: previous.members.map((m) =>
            m.userId === userId ? { ...m, role: body.role } : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(qkSettings.orgMembers(), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgMembers() });
    },
  });
}

// ── Teams ────────────────────────────────────────────────────────────────

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation<CreateTeamResponse, Error, CreateTeamRequest>({
    mutationFn: (body) => api.createTeam(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteTeam(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; body: AddTeamMemberRequest }>({
    mutationFn: ({ teamId, body }) => api.addTeamMember(teamId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useSetTeamMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { teamId: string; userId: string; body: SetTeamMemberRoleRequest }
  >({
    mutationFn: ({ teamId, userId, body }) => api.setTeamMemberRole(teamId, userId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
    },
  });
}

export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; userId: string }>({
    mutationFn: ({ teamId, userId }) => api.removeTeamMember(teamId, userId),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}
