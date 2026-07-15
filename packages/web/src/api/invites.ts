/**
 * TanStack Query hooks for `/api/org/invites` (org-admin only, split-settings
 * design). Mirrors the factory idiom in `~/api/settings`: query-key factory,
 * one hook per read, mutations invalidate the key they affect. The list read
 * never carries a plaintext code — `POST` returns one exactly once, held in
 * the caller's own state, never re-fetched.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  CreateInviteRequest,
  CreateInviteResponse,
  ListInvitesResponse,
  RevokeInviteResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkInvites = {
  all: () => ["settings", "org", "invites"] as const,
};

export function useInvites(opts?: UseQueryOptions<ListInvitesResponse>) {
  return useQuery<ListInvitesResponse>({
    queryKey: qkInvites.all(),
    queryFn: () => api.listInvites(),
    ...opts,
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation<CreateInviteResponse, Error, CreateInviteRequest>({
    mutationFn: (body) => api.createInvite(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkInvites.all() });
    },
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation<RevokeInviteResponse, Error, string>({
    mutationFn: (id) => api.revokeInvite(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkInvites.all() });
    },
  });
}
