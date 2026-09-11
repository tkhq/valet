/**
 * 1Password settings queries. Mirrors the factory idiom in
 * `~/api/integrations` / `~/api/settings`: a query-key factory, one hook per
 * read, and mutations that update the key they affect.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { OnePasswordSettingsResponse, PutOnePasswordSettingsRequest } from "@valet/api/wire";
import { api } from "./client";

export const onePasswordKeys = {
  team: (teamId: string) => ["onepassword", "team", teamId] as const,
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

export function useTeamOnePasswordStatus(teamId: string) {
  return useQuery({ queryKey: onePasswordKeys.team(teamId), queryFn: () => api.getTeamOnePasswordStatus(teamId) });
}

/** The control resets this mutation after each request; unused entries expire immediately. */
export function useTeamOnePasswordToken(teamId: string) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (token: string | null) => token === null
      ? api.deleteCredential("onepassword", { scope: "team", teamId })
      : api.putCredential("onepassword", { type: "service_account", apiKey: token, scope: "team", teamId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: onePasswordKeys.team(teamId) }),
    gcTime: 0,
  });
  return save;
}
