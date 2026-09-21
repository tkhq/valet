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
  DriveFolderScopeResponse,
  DriveFoldersResponse,
  DelegateCredentialRequest,
  DelegateCredentialResponse,
  ListCredentialsResponse,
  ListPluginsResponse,
  PutCredentialRequest,
  PutCredentialResponse,
} from "@valet/api/wire";
import { api } from "./client";
import { onePasswordKeys } from "./onepassword";

export type CredentialScope = "user" | "org" | "team";

export const qkIntegrations = {
  /** Prefix for every personal and team plugin catalog. */
  pluginsAll: () => ["plugins"] as const,
  plugins: (teamId?: string) => ["plugins", teamId ?? ""] as const,
  /** `scope` defaults to "user" — the caller's own credentials. "org"
   * (admin-only server-side) is a distinct cache entry, not a filter over
   * the same list. `/integrations` reads both when the caller is an admin.
   * "team" pins one team; `teamId` is part of the key. */
  credentials: (scope: CredentialScope = "user", teamId?: string) =>
    ["credentials", scope, teamId ?? ""] as const,
  /** The Drive folder scope on the caller's connection, or on a team's. */
  driveFolderScope: (service: string, teamId?: string) =>
    ["credentials", service, "folder-scope", teamId ?? ""] as const,
  /** One level of the Drive folder tree, keyed by connection and parent. */
  driveFolders: (service: string, parentId: string, teamId?: string) =>
    ["credentials", service, "drive-folders", teamId ?? "", parentId] as const,
};

export function usePlugins(teamId?: string, opts?: Partial<UseQueryOptions<ListPluginsResponse>>) {
  return useQuery<ListPluginsResponse>({
    queryKey: qkIntegrations.plugins(teamId),
    queryFn: () => api.listPlugins(teamId),
    ...opts,
  });
}

export function useCredentials(
  scope: CredentialScope = "user",
  opts?: Partial<UseQueryOptions<ListCredentialsResponse>> & { teamId?: string },
) {
  const { teamId, ...queryOpts } = opts ?? {};
  return useQuery<ListCredentialsResponse>({
    queryKey: qkIntegrations.credentials(scope, teamId),
    queryFn: () => api.listCredentials(scope, teamId),
    enabled: scope !== "team" || Boolean(teamId),
    ...queryOpts,
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
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
      qc.invalidateQueries({ queryKey: ["credentials"] });
      // The 1Password panel's Connected state reads its own settings query.
      qc.invalidateQueries({ queryKey: onePasswordKeys.settings() });
    },
  });
}

export function useDisconnectCredential() {
  const qc = useQueryClient();
  return useMutation<
    DeleteCredentialResponse,
    Error,
    { service: string; scope?: CredentialScope; teamId?: string }
  >({
    mutationFn: ({ service, scope, teamId }) =>
      api.deleteCredential(service, scope ? { scope, teamId } : undefined),
    onSuccess: (_data, { scope, teamId }) => {
      if (scope === "team") {
        // The completed request owns these invalidations, even after a
        // workspace switch. The team catalog includes direct credentials.
        qc.invalidateQueries({ queryKey: qkIntegrations.credentials("team", teamId) });
        qc.invalidateQueries({ queryKey: qkIntegrations.plugins(teamId) });
        return;
      }
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
      qc.invalidateQueries({ queryKey: ["credentials"] });
      qc.invalidateQueries({ queryKey: onePasswordKeys.settings() });
    },
  });
}

function invalidateCredentialCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
  qc.invalidateQueries({ queryKey: ["credentials"] });
}

export function useDelegateCredential() {
  const qc = useQueryClient();
  return useMutation<
    DelegateCredentialResponse,
    Error,
    { service: string; body: DelegateCredentialRequest }
  >({
    mutationFn: ({ service, body }) => api.delegateCredential(service, body),
    onSuccess: () => invalidateCredentialCaches(qc),
  });
}

export function useRevokeDelegation() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, { service: string; teamId: string }>({
    mutationFn: ({ service, teamId }) => api.revokeDelegation(service, teamId),
    onSuccess: () => invalidateCredentialCaches(qc),
  });
}


// ── Google Drive folder scope ──────────────────────────────────────

/** `teamId` reads a team's own connection; without it, the caller's. */
export function useDriveFolderScope(
  service: string,
  opts?: Partial<UseQueryOptions<DriveFolderScopeResponse>> & { teamId?: string },
) {
  const { teamId, ...queryOpts } = opts ?? {};
  return useQuery<DriveFolderScopeResponse>({
    queryKey: qkIntegrations.driveFolderScope(service, teamId),
    queryFn: () => api.getDriveFolderScope(service, teamId),
    ...queryOpts,
  });
}

export function useDriveFolders(
  service: string,
  parentId: string,
  opts?: Partial<UseQueryOptions<DriveFoldersResponse>> & { teamId?: string },
) {
  const { teamId, ...queryOpts } = opts ?? {};
  return useQuery<DriveFoldersResponse>({
    queryKey: qkIntegrations.driveFolders(service, parentId, teamId),
    queryFn: () => api.listDriveFolders(service, parentId === "root" ? undefined : parentId, teamId),
    ...queryOpts,
  });
}

/**
 * Save or clear the scope. `folderIds: null` clears it, which is not the
 * same as saving an empty list: an empty list allows nothing.
 */
export function useSetDriveFolderScope(service: string, teamId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderIds: string[] | null) =>
      folderIds === null
        ? api.clearDriveFolderScope(service, teamId)
        : api.putDriveFolderScope(service, folderIds, teamId),
    onSuccess: (data) => {
      qc.setQueryData(qkIntegrations.driveFolderScope(service, teamId), data);
    },
  });
}
