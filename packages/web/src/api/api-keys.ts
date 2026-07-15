/**
 * TanStack Query hooks over the better-auth `apiKey` client plugin
 * (`~/lib/auth-client`'s `authClient.apiKey`). Wraps the `{ data, error }`
 * result shape (same convention as `authClient.signIn.email` in
 * `routes/login.tsx`) into throwing `mutationFn`/`queryFn`s so the rest of
 * the app can use the ordinary `useQuery`/`useMutation` `error` surface.
 *
 * `ApiKeySummary` and `CreatedApiKey` are derived from the client's own
 * inferred return types rather than hand-transcribed, so a plugin version
 * bump can't silently drift the two apart.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "~/lib/auth-client";

export const qkApiKeys = {
  all: () => ["settings", "apiKeys"] as const,
};

type ListResult = Awaited<ReturnType<typeof authClient.apiKey.list>>;
export type ApiKeySummary = NonNullable<ListResult["data"]>["apiKeys"][number];

type CreateResult = Awaited<ReturnType<typeof authClient.apiKey.create>>;
export type CreatedApiKey = NonNullable<CreateResult["data"]>;

export function useApiKeys() {
  return useQuery<ApiKeySummary[]>({
    queryKey: qkApiKeys.all(),
    queryFn: async () => {
      const { data, error } = await authClient.apiKey.list();
      if (error) throw new Error(error.message ?? "Couldn't load API keys.");
      return data?.apiKeys ?? [];
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
      qc.invalidateQueries({ queryKey: qkApiKeys.all() });
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
      qc.invalidateQueries({ queryKey: qkApiKeys.all() });
    },
  });
}
