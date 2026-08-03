/**
 * TanStack Query hooks for `/api/org/sources` (sandbox-reconciliation plan,
 * Task 18). Mirrors the factory idiom in `src/api/settings.ts`: query-key
 * factory object, one hook per read, mutations invalidate the keys they affect.
 *
 * All routes are org-admin-gated on the server (`requireOrgAdmin`); the hooks
 * do not re-check permissions client-side — the `OrgRouteGuard` on the settings
 * route handles that.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  BakeSummary,
  CreateSourceResponse,
  ListBakesResponse,
  ListSourcesResponse,
  PatchSourceResponse,
  SourceSummary,
  TriggerBakeResponse,
} from "@valet/api/wire";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────────

export const qkSources = {
  all: () => ["sources"] as const,
  bakes: (sourceId: string) => ["sources", sourceId, "bakes"] as const,
};

// ── Read hooks ───────────────────────────────────────────────────────────────

export function useSources() {
  return useQuery<ListSourcesResponse>({
    queryKey: qkSources.all(),
    queryFn: () => api.listSources(),
  });
}

export function useSourceBakes(sourceId: string, opts?: { enabled?: boolean }) {
  return useQuery<ListBakesResponse>({
    queryKey: qkSources.bakes(sourceId),
    queryFn: () => api.listSourceBakes(sourceId),
    enabled: opts?.enabled ?? true,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

/** Create a new source. `body` is typed loosely so callers compose
 * kind-specific fields (external needs `name`+`externalRef`; base needs
 * `name`+`setupCommands`). The server validates kind-scoped fields. */
export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation<CreateSourceResponse, Error, Record<string, unknown>>({
    mutationFn: (body) => api.createSource(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSources.all() });
    },
  });
}

export function usePatchSource() {
  const qc = useQueryClient();
  return useMutation<PatchSourceResponse, Error, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => api.patchSource(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSources.all() });
    },
  });
}

export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteSource(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSources.all() });
    },
  });
}

export function useBakeSource() {
  const qc = useQueryClient();
  return useMutation<TriggerBakeResponse, Error, string>({
    mutationFn: (id) => api.bakeSource(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: qkSources.bakes(id) });
      qc.invalidateQueries({ queryKey: qkSources.all() });
    },
  });
}

// Re-export wire types so callers can import from one place.
export type { SourceSummary, BakeSummary, ListSourcesResponse, ListBakesResponse };
