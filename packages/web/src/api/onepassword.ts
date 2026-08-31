/**
 * 1Password settings + picker-backend queries (1Password credential
 * provider plan, Task 4). Mirrors the factory idiom in `~/api/integrations`
 * / `~/api/settings`: query-key factory object, one hook per read,
 * mutations invalidate the keys they affect.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  ListOpItemsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
  PutOnePasswordSettingsRequest,
} from "@valet/api/wire";
import { api } from "./client";

export type OnePasswordTokenScope = "org" | "personal";

export const onePasswordKeys = {
  settings: () => ["onepassword", "settings"] as const,
  vaults: (scope: OnePasswordTokenScope) => ["onepassword", "vaults", scope] as const,
  items: (scope: OnePasswordTokenScope, vaultId: string) =>
    ["onepassword", "vaults", scope, vaultId, "items"] as const,
  itemDetail: (scope: OnePasswordTokenScope, vaultId: string, itemId: string) =>
    ["onepassword", "vaults", scope, vaultId, "items", itemId] as const,
};

export function useOnePasswordSettings(
  opts?: Partial<UseQueryOptions<OnePasswordSettingsResponse>>,
) {
  return useQuery<OnePasswordSettingsResponse>({
    queryKey: onePasswordKeys.settings(),
    queryFn: () => api.getOnePasswordSettings(),
    ...opts,
  });
}

export function usePutOnePasswordSettings() {
  const qc = useQueryClient();
  return useMutation<OnePasswordSettingsResponse, Error, PutOnePasswordSettingsRequest>({
    mutationFn: (body) => api.putOnePasswordSettings(body),
    onSuccess: (data) => {
      qc.setQueryData(onePasswordKeys.settings(), data);
    },
  });
}

/** Step 1 of the picker cascade — always enabled (no predecessor). */
export function useOpVaults(
  scope: OnePasswordTokenScope,
  opts?: Partial<UseQueryOptions<ListOpVaultsResponse>>,
) {
  return useQuery<ListOpVaultsResponse>({
    queryKey: onePasswordKeys.vaults(scope),
    queryFn: () => api.listOpVaults(scope),
    ...opts,
  });
}

/** Step 2 — disabled until a vault is chosen (`vaultId` undefined). */
export function useOpItems(
  scope: OnePasswordTokenScope,
  vaultId: string | undefined,
  opts?: Partial<UseQueryOptions<ListOpItemsResponse>>,
) {
  return useQuery<ListOpItemsResponse>({
    queryKey: onePasswordKeys.items(scope, vaultId ?? ""),
    queryFn: () => api.listOpItems(scope, vaultId as string),
    enabled: !!vaultId,
    ...opts,
  });
}

/** Step 3 — disabled until both a vault and an item are chosen. */
export function useOpItemDetail(
  scope: OnePasswordTokenScope,
  vaultId: string | undefined,
  itemId: string | undefined,
  opts?: Partial<UseQueryOptions<OpItemDetailResponse>>,
) {
  return useQuery<OpItemDetailResponse>({
    queryKey: onePasswordKeys.itemDetail(scope, vaultId ?? "", itemId ?? ""),
    queryFn: () => api.getOpItemDetail(scope, vaultId as string, itemId as string),
    enabled: !!vaultId && !!itemId,
    ...opts,
  });
}
