/**
 * TanStack Query hooks for API keys. Personal keys go through better-auth
 * (`authClient.apiKey`). Team keys go through `/api/teams/:id/api-keys`.
 * The query key includes the workspace so switching does not flash the
 * other place's rows.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateTeamApiKeyResponse, TeamApiKeySummary } from "@valet/api/wire";
import { authClient } from "~/lib/auth-client";
import { api } from "./client";

export const qkApiKeys = {
  all: () => ["settings", "apiKeys"] as const,
  personal: () => ["settings", "apiKeys", "user"] as const,
  team: (teamId: string) => ["settings", "apiKeys", "team", teamId] as const,
};

type ListResult = Awaited<ReturnType<typeof authClient.apiKey.list>>;
export type ApiKeySummary = NonNullable<ListResult["data"]>["apiKeys"][number];

type CreateResult = Awaited<ReturnType<typeof authClient.apiKey.create>>;
export type CreatedApiKey = NonNullable<CreateResult["data"]>;

function isTeamScopedKey(key: ApiKeySummary): boolean {
  if (!("metadata" in key)) return false;
  const metadata = key.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (!("teamId" in metadata)) return false;
  return typeof metadata.teamId === "string" && metadata.teamId.length > 0;
}

export function useApiKeys() {
  return useQuery<ApiKeySummary[]>({
    queryKey: qkApiKeys.personal(),
    queryFn: async () => {
      const { data, error } = await authClient.apiKey.list();
      if (error) throw new Error(error.message ?? "Couldn't load API keys.");
      return (data?.apiKeys ?? []).filter((key) => !isTeamScopedKey(key));
    },
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation<CreatedApiKey, Error, string>({
    mutationFn: async (name) => {
      const { data, error } = await authClient.apiKey.create({ name });
      if (error) throw new Error(error.message ?? "Couldn't create API key.");
      if (!data) throw new Error("Couldn't create API key.");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkApiKeys.personal() });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (keyId) => {
      const { error } = await authClient.apiKey.delete({ keyId });
      if (error) throw new Error(error.message ?? "Couldn't revoke API key.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkApiKeys.personal() });
    },
  });
}

export function useTeamApiKeys(teamId: string) {
  return useQuery<TeamApiKeySummary[]>({
    queryKey: qkApiKeys.team(teamId),
    queryFn: async () => {
      const data = await api.listTeamApiKeys(teamId);
      return data.keys;
    },
  });
}

export function useCreateTeamApiKey(teamId: string) {
  const qc = useQueryClient();
  return useMutation<CreateTeamApiKeyResponse, Error, string>({
    mutationFn: (name) => api.createTeamApiKey(teamId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkApiKeys.team(teamId) });
    },
  });
}

export function useRevokeTeamApiKey(teamId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (keyId) => {
      await api.revokeTeamApiKey(teamId, keyId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkApiKeys.team(teamId) });
    },
  });
}
