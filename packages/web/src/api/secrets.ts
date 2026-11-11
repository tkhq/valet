/**
 * TanStack Query hooks for the caller's personal secrets. Names only: the
 * API never returns a value.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretSummary, SecretsListResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkSecrets = () => ["settings", "secrets"] as const;

export function useSecrets() {
  return useQuery<SecretsListResponse>({
    queryKey: qkSecrets(),
    queryFn: () => api.listSecrets(),
  });
}

export function useSaveSecret() {
  const qc = useQueryClient();
  return useMutation<SecretSummary, Error, { name: string; value: string }>({
    mutationFn: (body) => api.saveSecret(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkSecrets() }),
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (name) => {
      await api.deleteSecret(name);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qkSecrets() }),
  });
}
