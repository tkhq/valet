/**
 * 1Password settings queries. Mirrors the factory idiom in
 * `~/api/integrations` / `~/api/settings`: a query-key factory, one hook per
 * read, and mutations that update the key they affect.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { OnePasswordSettingsResponse, PutOnePasswordSettingsRequest } from "@valet/api/wire";
import { api } from "./client";

export const onePasswordKeys = {
  settings: () => ["onepassword", "settings"] as const,
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
