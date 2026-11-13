/**
 * Secrets in the deployment's secret store: company, team, and personal.
 * Names only: the API never returns a value.
 *
 * Every save goes through `saveSecretValue`: the api authorizes the scope
 * and name and returns an envelope, the browser seals the value to it, and
 * the api receives only the sealed value. The Settings page, the secret
 * request card in a thread, and the composer's paste prompt all use it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretScopeKind, SecretSummary, SecretsListResponse } from "@valet/api/wire";
import { sealSecret } from "~/lib/secret-seal";
import { api } from "./client";

export interface SecretTarget {
  scope: SecretScopeKind;
  /** Set only for the team scope. */
  teamId?: string;
}

export const qkSecretsAll = () => ["settings", "secrets"] as const;
export const qkSecrets = (target: SecretTarget) => ["settings", "secrets", target.scope, target.teamId ?? ""] as const;

export function useSecrets(target: SecretTarget) {
  return useQuery<SecretsListResponse>({
    queryKey: qkSecrets(target),
    queryFn: () => api.listSecrets(target.scope, target.teamId),
  });
}

/** Seal `value` in the browser and save it as `name` in `target`. With
 * `replace`, a secret already saved under `name` gets the new value. */
export async function saveSecretValue(
  target: SecretTarget,
  name: string,
  value: string,
  opts: { replace?: boolean } = {},
): Promise<SecretSummary> {
  const request = {
    scope: target.scope,
    name,
    ...(target.teamId ? { teamId: target.teamId } : {}),
    ...(opts.replace ? { replace: true } : {}),
  };
  const { envelope } = await api.beginSecretSave(request);
  const sealed = await sealSecret(envelope, value);
  return api.finishSecretSave({ ...request, sealed });
}

export function useSaveSecret(target: SecretTarget) {
  const qc = useQueryClient();
  return useMutation<SecretSummary, Error, { name: string; value: string; replace?: boolean }>({
    mutationFn: ({ name, value, replace }) => saveSecretValue(target, name, value, { replace }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkSecretsAll() }),
  });
}

export function useDeleteSecret(target: SecretTarget) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (name) => {
      await api.deleteSecret(target.scope, target.teamId, name);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qkSecretsAll() }),
  });
}
