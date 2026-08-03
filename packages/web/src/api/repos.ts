/**
 * Repo listing + per-user GitHub connect (GitHub/repo integration plan,
 * Tasks 6/7/11). Mirrors the factory idiom in `~/api/queries` /
 * `~/api/integrations`: query-key factory, mutations invalidate the keys
 * they affect.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { GetPrebuildForRepoResponse, GetReposResponse, PostGithubConnectResponse } from "@valet/api/wire";
import { api } from "./client";
import { qkIntegrations } from "./integrations";
import { qkSettings } from "./settings";

export const qkRepos = {
  list: () => ["repos"] as const,
  prebuildForRepo: (fullName: string) => ["repos", "prebuild", fullName] as const,
};

/** `GET /api/repos` — the new-session repo picker's source. A short
 * staleTime avoids a refetch on every dialog open while still catching
 * connect/install changes made moments earlier in the same tab. */
export function useRepos(opts?: UseQueryOptions<GetReposResponse>) {
  return useQuery<GetReposResponse>({
    queryKey: qkRepos.list(),
    queryFn: () => api.getRepos(),
    staleTime: 60_000,
    ...opts,
  });
}

/** Mints the GitHub OAuth authorize URL; the caller redirects the browser
 * there. No state changes until the user completes the flow and lands back
 * on `GET /api/me/github/callback`, but invalidating here is harmless and
 * keeps the three read surfaces (github-app, credentials, repos) that a
 * completed connect affects consistent if the redirect returns quickly. */
export function useConnectGithub() {
  const qc = useQueryClient();
  return useMutation<PostGithubConnectResponse, Error, void>({
    mutationFn: () => api.connectGithub(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials() });
      qc.invalidateQueries({ queryKey: qkRepos.list() });
    },
  });
}

/** `GET /api/sources/for-repo` — member-accessible (sandbox-reconciliation
 * plan, Task 17). Powers the new-session dialog's "prebuilt" badge; `enabled`
 * gates it so it only fires once a repo is actually selected. */
export function useRepoPrebuild(fullName: string | undefined) {
  return useQuery<GetPrebuildForRepoResponse>({
    queryKey: qkRepos.prebuildForRepo(fullName ?? ""),
    queryFn: () => api.getPrebuildForRepo(fullName as string),
    enabled: fullName !== undefined && fullName.trim() !== "",
    staleTime: 60_000,
  });
}

export function useDisconnectGithub() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, void>({
    mutationFn: () => api.disconnectGithub(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
      qc.invalidateQueries({ queryKey: qkIntegrations.credentials() });
      qc.invalidateQueries({ queryKey: qkRepos.list() });
    },
  });
}
