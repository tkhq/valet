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
  ListModelsResponse,
  MeResponse,
  OrgMembersResponse,
  OrgResponse,
  PatchMeRequest,
  PatchMeResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgRequest,
  PatchOrgResponse,
} from "@valet/api/wire";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qkSettings = {
  me: () => ["settings", "me"] as const,
  org: () => ["settings", "org"] as const,
  orgMembers: () => ["settings", "org", "members"] as const,
  models: () => ["settings", "models"] as const,
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
    { userId: string; body: PatchOrgMemberRequest }
  >({
    mutationFn: ({ userId, body }) => api.patchOrgMember(userId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgMembers() });
    },
  });
}
