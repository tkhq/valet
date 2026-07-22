/**
 * Plugins + credentials queries (plugin-system-v2 plan Task 15 — connect
 * surface, manual token entry only). House pattern: a query-key factory per
 * resource file, mirroring `~/api/workflows` / `~/api/orchestrator`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  DeleteCredentialResponse,
  ListCredentialsResponse,
  ListPluginsResponse,
  PutCredentialRequest,
  PutCredentialResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkIntegrations = {
  plugins: () => ["plugins"] as const,
  /** `scope` defaults to "user" — the caller's own credentials. "org"
   * (admin-only server-side) is a distinct cache entry, not a filter over
   * the same list (1Password credential provider plan, Task 4: the org
   * settings page reads the org-scoped list independently of the personal
   * connected-accounts page). */
  credentials: (scope: "user" | "org" = "user") => ["credentials", scope] as const,
};

export function usePlugins(opts?: Partial<UseQueryOptions<ListPluginsResponse>>) {
  return useQuery<ListPluginsResponse>({
    queryKey: qkIntegrations.plugins(),
    queryFn: () => api.listPlugins(),
    ...opts,
  });
}

export function useCredentials(
  scope: "user" | "org" = "user",
  opts?: Partial<UseQueryOptions<ListCredentialsResponse>>,
) {
  return useQuery<ListCredentialsResponse>({
    queryKey: qkIntegrations.credentials(scope),
    queryFn: () => api.listCredentials(scope),
    ...opts,
  });
}

/** Connect (or reconnect) a service. Invalidates both the plugin list
 * (connected flags) and both credential-scope caches after a successful
 * save — the response doesn't echo the resolved owner scope, so the exact
 * key affected isn't knowable here without re-deriving it from `body.scope`. */
export function useConnectCredential() {
  const qc = useQueryClient();
  return useMutation<PutCredentialResponse, Error, { service: string; body: PutCredentialRequest }>({
    mutationFn: ({ service, body }) => api.putCredential(service, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkIntegrations.plugins() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials("user") });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials("org") });
    },
  });
}

export function useDisconnectCredential() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, { service: string; scope?: "user" | "org" }>({
    mutationFn: ({ service, scope }) => api.deleteCredential(service, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkIntegrations.plugins() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials("user") });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials("org") });
    },
  });
}
