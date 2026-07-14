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
  credentials: () => ["credentials"] as const,
};

export function usePlugins(opts?: Partial<UseQueryOptions<ListPluginsResponse>>) {
  return useQuery<ListPluginsResponse>({
    queryKey: qkIntegrations.plugins(),
    queryFn: () => api.listPlugins(),
    ...opts,
  });
}

export function useCredentials(opts?: Partial<UseQueryOptions<ListCredentialsResponse>>) {
  return useQuery<ListCredentialsResponse>({
    queryKey: qkIntegrations.credentials(),
    queryFn: () => api.listCredentials(),
    ...opts,
  });
}

/** Connect (or reconnect) a service. Invalidates both the plugin list
 * (connected flags) and the credential list after a successful save. */
export function useConnectCredential() {
  const qc = useQueryClient();
  return useMutation<PutCredentialResponse, Error, { service: string; body: PutCredentialRequest }>({
    mutationFn: ({ service, body }) => api.putCredential(service, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkIntegrations.plugins() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials() });
    },
  });
}

export function useDisconnectCredential() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, string>({
    mutationFn: (service) => api.deleteCredential(service),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkIntegrations.plugins() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials() });
    },
  });
}
