/**
 * TanStack Query hooks for the action-policies web surfaces (Task 5):
 * org-admin policy CRUD + preview + action log, and the per-user
 * policy-overrides / runtime-grants surfaces. Mirrors the factory idiom in
 * `src/api/settings.ts` — query-key factory object, one hook per read,
 * mutations invalidate the keys they affect.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateOrgPolicyRequest,
  CreateOrgPolicyResponse,
  DeleteGrantRequest,
  DeleteGrantResponse,
  DeleteOrgPolicyResponse,
  DeletePolicyOverrideRequest,
  DeletePolicyOverrideResponse,
  ListActionLogResponse,
  ListGrantsResponse,
  ListOrgPoliciesResponse,
  ListPolicyOverridesResponse,
  PatchOrgPolicyRequest,
  PatchOrgPolicyResponse,
  PreviewOrgPolicyRequest,
  PreviewOrgPolicyResponse,
  PutPolicyOverrideRequest,
  PutPolicyOverrideResponse,
} from "@valet/api/wire";
import { api, ApiError } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qkPolicies = {
  orgPolicies: () => ["policies", "org"] as const,
  actionLog: (filters: ActionLogFilterState) => ["policies", "action-log", filters] as const,
  myOverrides: () => ["policies", "me", "overrides"] as const,
  myGrants: () => ["policies", "me", "grants"] as const,
};

export interface ActionLogFilterState {
  service?: string;
  userId?: string;
  resolvedMode?: string;
  status?: string;
  from?: number;
  to?: number;
}

/** Extracts the API's error message verbatim from an `ApiError` payload
 *  (`{ error: string }`), falling back to `err.message`. Used across the
 *  policy surfaces so a 400 like "would loosen past an org deny" reaches the
 *  user unmodified rather than being swallowed into a generic toast. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.payload === "object" && err.payload !== null && "error" in err.payload) {
    const { error } = err.payload as { error: unknown };
    if (typeof error === "string") return error;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

// ── Org policies (admin) ────────────────────────────────────────────────

export function useOrgPolicies(opts?: UseQueryOptions<ListOrgPoliciesResponse>) {
  return useQuery<ListOrgPoliciesResponse>({
    queryKey: qkPolicies.orgPolicies(),
    queryFn: () => api.listOrgPolicies(),
    ...opts,
  });
}

export function useCreateOrgPolicy() {
  const qc = useQueryClient();
  return useMutation<CreateOrgPolicyResponse, Error, CreateOrgPolicyRequest>({
    mutationFn: (body) => api.createOrgPolicy(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.orgPolicies() });
    },
  });
}

export function usePatchOrgPolicy() {
  const qc = useQueryClient();
  return useMutation<PatchOrgPolicyResponse, Error, { id: string; body: PatchOrgPolicyRequest }>({
    mutationFn: ({ id, body }) => api.patchOrgPolicy(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.orgPolicies() });
    },
  });
}

export function useDeleteOrgPolicy() {
  const qc = useQueryClient();
  return useMutation<DeleteOrgPolicyResponse, Error, string>({
    mutationFn: (id) => api.deleteOrgPolicy(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.orgPolicies() });
    },
  });
}

export function usePreviewOrgPolicy() {
  return useMutation<PreviewOrgPolicyResponse, Error, PreviewOrgPolicyRequest>({
    mutationFn: (body) => api.previewOrgPolicy(body),
  });
}

// ── Action log (admin, keyset-paginated) ────────────────────────────────

export function useActionLog(
  filters: ActionLogFilterState,
  cursor: string | undefined,
  opts?: UseQueryOptions<ListActionLogResponse>,
) {
  return useQuery<ListActionLogResponse>({
    queryKey: [...qkPolicies.actionLog(filters), cursor ?? null],
    queryFn: () => api.listActionLog({ ...filters, cursor }),
    ...opts,
  });
}

// ── My policy overrides ──────────────────────────────────────────────────

export function useMyPolicyOverrides(opts?: UseQueryOptions<ListPolicyOverridesResponse>) {
  return useQuery<ListPolicyOverridesResponse>({
    queryKey: qkPolicies.myOverrides(),
    queryFn: () => api.listMyPolicyOverrides(),
    ...opts,
  });
}

export function usePutMyPolicyOverride() {
  const qc = useQueryClient();
  return useMutation<PutPolicyOverrideResponse, Error, PutPolicyOverrideRequest>({
    mutationFn: (body) => api.putMyPolicyOverride(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.myOverrides() });
    },
  });
}

export function useDeleteMyPolicyOverride() {
  const qc = useQueryClient();
  return useMutation<DeletePolicyOverrideResponse, Error, DeletePolicyOverrideRequest>({
    mutationFn: (body) => api.deleteMyPolicyOverride(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.myOverrides() });
    },
  });
}

// ── My runtime grants ────────────────────────────────────────────────────

export function useMyGrants(opts?: UseQueryOptions<ListGrantsResponse>) {
  return useQuery<ListGrantsResponse>({
    queryKey: qkPolicies.myGrants(),
    queryFn: () => api.listMyGrants(),
    ...opts,
  });
}

export function useDeleteMyGrant() {
  const qc = useQueryClient();
  return useMutation<DeleteGrantResponse, Error, DeleteGrantRequest>({
    mutationFn: (body) => api.deleteMyGrant(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkPolicies.myGrants() });
    },
  });
}
