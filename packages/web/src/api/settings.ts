/**
 * TanStack Query hooks for the settings shell's data surface (split-settings
 * design, Task 5). Mirrors the factory idiom in `src/api/queries.ts`:
 * query-key factory object, one hook per read, mutations invalidate the
 * keys they affect. `/api/me`, `/api/org`, `/api/org/members`, `/api/models`
 * are the four reads; `/api/me`, `/api/org`, `/api/org/members/:userId` are
 * the three writes Tasks 6–7 wire up to actual controls.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  AddTeamMemberRequest,
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  DeleteCredentialResponse,
  GetGithubAppResponse,
  GetLlmProviderPreferencesResponse,
  GetSlackAppResponse,
  ListLlmProvidersResponse,
  ListModelsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  MeResponse,
  OpenrouterRegistryResponse,
  OrgMembersResponse,
  OrgResponse,
  OrgSettingsResponse,
  PatchLlmProviderRequest,
  PatchLlmProviderResponse,
  PatchMeRequest,
  PatchMeResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgRequest,
  PatchOrgResponse,
  PatchOrgSettingsRequest,
  PostGithubAppCredentialRequest,
  PostGithubAppManifestRequest,
  PostGithubAppManifestResponse,
  ProbeLlmProviderResponse,
  PutCredentialResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  PutLlmProviderPreferencesRequest,
  PutLlmProviderPreferencesResponse,
  SetTeamMemberRoleRequest,
  TestLlmProviderRequest,
  TestLlmProviderResponse,
} from "@valet/api/wire";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qkSettings = {
  me: () => ["settings", "me"] as const,
  org: () => ["settings", "org"] as const,
  orgMembers: () => ["settings", "org", "members"] as const,
  models: () => ["settings", "models"] as const,
  llmProviders: () => ["settings", "llmProviders"] as const,
  openrouterRegistry: () => ["settings", "openrouterRegistry"] as const,
  llmProviderPreferences: () => ["settings", "llmProviderPreferences"] as const,
  teams: () => ["settings", "teams"] as const,
  teamMembers: (teamId: string) => ["settings", "teams", teamId, "members"] as const,
  githubApp: () => ["settings", "githubApp"] as const,
  /** Prefix of every `slackApp` key — what the mutations invalidate. */
  slackAppAll: () => ["settings", "slackApp"] as const,
  /** One manifest per requested app name; `""` is the server default name. */
  slackApp: (name?: string) => ["settings", "slackApp", name ?? ""] as const,
};

/** Shared across every `usePatchMe()` instance so overlapping default-model
 * and preference writes see each other in `isMutating`. */
export const patchMeMutationKey = ["settings", "patchMe"] as const;
export const putLlmProviderPreferencesMutationKey = ["settings", "putLlmProviderPreferences"] as const;

/** Serializes overlapping list edits so an earlier PATCH/PUT cannot overwrite
 * a later one. Distinct from `mutationKey` — TanStack scopes by this id. */
const patchMeMutationScope = { id: "settings.patchMe" } as const;
const putLlmProviderPreferencesMutationScope = {
  id: "settings.putLlmProviderPreferences",
} as const;

/**
 * TanStack Query 5.90 runs `onSettled` while this mutation is still
 * `pending`, so `isMutating` still counts it. Invalidate when at most this
 * one remains — a zero check never fires after the last write.
 */
function noOtherMutationsPending(qc: QueryClient, mutationKey: readonly string[]): boolean {
  return qc.isMutating({ mutationKey: [...mutationKey] }) <= 1;
}

export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Optimistic `/api/me` cache write used by list add/remove/reorder. */
export function mergePatchMe(previous: MeResponse, body: PatchMeRequest): MeResponse {
  return {
    ...previous,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
    ...("defaultModel" in body ? { defaultModel: body.defaultModel ?? null } : {}),
    ...(body.modelPreferences !== undefined ? { modelPreferences: body.modelPreferences } : {}),
  };
}

/**
 * Roll back only fields this mutation wrote, and only if the cache still
 * holds that optimistic value. A later overlapping PATCH must not lose its
 * write when an earlier one fails.
 */
export function revertPatchMe(
  current: MeResponse,
  previous: MeResponse,
  body: PatchMeRequest,
): MeResponse {
  const next = { ...current };
  if (body.name !== undefined && current.name === body.name) next.name = previous.name;
  if (body.avatarUrl !== undefined && current.avatarUrl === body.avatarUrl) {
    next.avatarUrl = previous.avatarUrl;
  }
  if ("defaultModel" in body && current.defaultModel === (body.defaultModel ?? null)) {
    next.defaultModel = previous.defaultModel;
  }
  if (
    body.modelPreferences !== undefined &&
    sameStringList(current.modelPreferences, body.modelPreferences)
  ) {
    next.modelPreferences = previous.modelPreferences;
  }
  return next;
}

// ── Reads ────────────────────────────────────────────────────────────────

export function useMe(opts?: UseQueryOptions<MeResponse>) {
  return useQuery<MeResponse>({
    queryKey: qkSettings.me(),
    queryFn: () => api.getMe(),
    ...opts,
  });
}

export function useOrg(opts?: UseQueryOptions<OrgResponse>) {
  return useQuery<OrgResponse>({
    queryKey: qkSettings.org(),
    queryFn: () => api.getOrg(),
    // The workspace clause mounts this on every list page, so each route
    // change would otherwise refetch it (app default staleTime is 5s). Org
    // facts change rarely and their mutations invalidate the key — same
    // reasoning as `useModels` below.
    staleTime: 60_000,
    ...opts,
  });
}

export function useOrgMembers(opts?: UseQueryOptions<OrgMembersResponse>) {
  return useQuery<OrgMembersResponse>({
    queryKey: qkSettings.orgMembers(),
    queryFn: () => api.getOrgMembers(),
    ...opts,
  });
}

export function useModels(opts?: UseQueryOptions<ListModelsResponse>) {
  return useQuery<ListModelsResponse>({
    queryKey: qkSettings.models(),
    queryFn: () => api.listModels(),
    // Org-admin-editable catalog (LLM providers, model preferences) — Task 7's
    // mutations already invalidate this key on write, but a short staleTime
    // covers changes made from elsewhere (another tab, another org admin).
    staleTime: 60_000,
    ...opts,
  });
}

export function useLlmProviders(opts?: UseQueryOptions<ListLlmProvidersResponse>) {
  return useQuery<ListLlmProvidersResponse>({
    queryKey: qkSettings.llmProviders(),
    queryFn: () => api.listLlmProviders(),
    ...opts,
  });
}

/** Full pi-ai openrouter registry (server-side, no upstream call) — powers
 * the openrouter card's model-selection picker. Static per deploy, so an
 * infinite staleTime; fetched only when the picker opens (`enabled`). */
export function useOpenrouterRegistry(opts?: { enabled?: boolean }) {
  return useQuery<OpenrouterRegistryResponse>({
    queryKey: qkSettings.openrouterRegistry(),
    queryFn: () => api.openrouterRegistry(),
    staleTime: Infinity,
    enabled: opts?.enabled ?? true,
  });
}

export function useLlmProviderPreferences(opts?: UseQueryOptions<GetLlmProviderPreferencesResponse>) {
  return useQuery<GetLlmProviderPreferencesResponse>({
    queryKey: qkSettings.llmProviderPreferences(),
    queryFn: () => api.getLlmProviderPreferences(),
    ...opts,
  });
}

export function useTeams(opts?: UseQueryOptions<ListTeamsResponse>) {
  return useQuery<ListTeamsResponse>({
    queryKey: qkSettings.teams(),
    queryFn: () => api.listTeams(),
    // Same rule as `useOrg`: read by the workspace clause on every list
    // page; team mutations already invalidate this key.
    staleTime: 60_000,
    ...opts,
  });
}

export function useTeamMembers(teamId: string, opts?: UseQueryOptions<ListTeamMembersResponse>) {
  return useQuery<ListTeamMembersResponse>({
    queryKey: qkSettings.teamMembers(teamId),
    queryFn: () => api.listTeamMembers(teamId),
    ...opts,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation<
    PatchMeResponse,
    Error,
    PatchMeRequest,
    { previous: MeResponse | undefined }
  >({
    mutationKey: patchMeMutationKey,
    scope: patchMeMutationScope,
    mutationFn: (body) => api.patchMe(body),
    onMutate: async (body) => {
      // Optimistic: list edits (add/remove/reorder) read from this cache.
      // Without a sync write, two quick edits both send the same stale array.
      await qc.cancelQueries({ queryKey: qkSettings.me() });
      const previous = qc.getQueryData<MeResponse>(qkSettings.me());
      if (previous) {
        qc.setQueryData<MeResponse>(qkSettings.me(), mergePatchMe(previous, body));
      }
      return { previous };
    },
    onError: (_err, body, context) => {
      if (!context?.previous) return;
      const current = qc.getQueryData<MeResponse>(qkSettings.me());
      if (!current) return;
      qc.setQueryData(qkSettings.me(), revertPatchMe(current, context.previous, body));
    },
    onSettled: () => {
      // Skip refetch while another PATCH /api/me is in flight — it would
      // overwrite that mutation's optimistic list.
      if (noOtherMutationsPending(qc, patchMeMutationKey)) {
        qc.invalidateQueries({ queryKey: qkSettings.me() });
      }
    },
  });
}

export function usePatchOrg() {
  const qc = useQueryClient();
  return useMutation<PatchOrgResponse, Error, PatchOrgRequest>({
    mutationFn: (body) => api.patchOrg(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

/** Org-level toggles (`PATCH /api/org/settings`) — invalidates the org
 * read, which is where `allowPublicArtifacts` is surfaced to members. */
export function usePatchOrgSettings() {
  const qc = useQueryClient();
  return useMutation<OrgSettingsResponse, Error, PatchOrgSettingsRequest>({
    mutationFn: (body) => api.patchOrgSettings(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

export function useSetOrgMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    PatchOrgMemberResponse,
    Error,
    { userId: string; body: PatchOrgMemberRequest },
    { previous: OrgMembersResponse | undefined }
  >({
    mutationFn: ({ userId, body }) => api.patchOrgMember(userId, body),
    // Optimistic: the row flips immediately, then rolls back if the server
    // rejects it (e.g. the last-admin guard) — the UI disable on the sole
    // admin row is a courtesy, not the source of truth.
    onMutate: async ({ userId, body }) => {
      await qc.cancelQueries({ queryKey: qkSettings.orgMembers() });
      const previous = qc.getQueryData<OrgMembersResponse>(qkSettings.orgMembers());
      if (previous) {
        qc.setQueryData<OrgMembersResponse>(qkSettings.orgMembers(), {
          members: previous.members.map((m) =>
            m.userId === userId ? { ...m, role: body.role } : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(qkSettings.orgMembers(), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgMembers() });
    },
  });
}

// ── LLM providers ────────────────────────────────────────────────────────

export function useCreateLlmProvider() {
  const qc = useQueryClient();
  return useMutation<CreateLlmProviderResponse, Error, CreateLlmProviderRequest>({
    mutationFn: (body) => api.createLlmProvider(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePatchLlmProvider() {
  const qc = useQueryClient();
  return useMutation<PatchLlmProviderResponse, Error, { id: string; body: PatchLlmProviderRequest }>({
    mutationFn: ({ id, body }) => api.patchLlmProvider(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useDeleteLlmProvider() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, string>({
    mutationFn: (id) => api.deleteLlmProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePutLlmProviderKey() {
  const qc = useQueryClient();
  return useMutation<PutLlmProviderKeyResponse, Error, { id: string; body: PutLlmProviderKeyRequest }>({
    mutationFn: ({ id, body }) => api.putLlmProviderKey(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useDeleteLlmProviderKey() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, string>({
    mutationFn: (id) => api.deleteLlmProviderKey(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useProbeLlmProvider() {
  return useMutation<ProbeLlmProviderResponse, Error, string>({
    mutationFn: (id) => api.probeLlmProvider(id),
  });
}

export function useTestLlmProvider() {
  return useMutation<TestLlmProviderResponse, Error, { id: string; body: TestLlmProviderRequest }>({
    mutationFn: ({ id, body }) => api.testLlmProvider(id, body),
  });
}

export function usePutLlmProviderPreferences() {
  const qc = useQueryClient();
  return useMutation<
    PutLlmProviderPreferencesResponse,
    Error,
    PutLlmProviderPreferencesRequest,
    { previous: GetLlmProviderPreferencesResponse | undefined }
  >({
    mutationKey: putLlmProviderPreferencesMutationKey,
    scope: putLlmProviderPreferencesMutationScope,
    mutationFn: (body) => api.putLlmProviderPreferences(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qkSettings.llmProviderPreferences() });
      const previous = qc.getQueryData<GetLlmProviderPreferencesResponse>(
        qkSettings.llmProviderPreferences(),
      );
      if (previous) {
        qc.setQueryData<GetLlmProviderPreferencesResponse>(qkSettings.llmProviderPreferences(), {
          preferences: body.preferences,
        });
      }
      return { previous };
    },
    onError: (_err, body, context) => {
      if (!context?.previous) return;
      const current = qc.getQueryData<GetLlmProviderPreferencesResponse>(
        qkSettings.llmProviderPreferences(),
      );
      if (!current) return;
      if (sameStringList(current.preferences, body.preferences)) {
        qc.setQueryData(qkSettings.llmProviderPreferences(), context.previous);
      }
    },
    onSettled: () => {
      if (noOtherMutationsPending(qc, putLlmProviderPreferencesMutationKey)) {
        qc.invalidateQueries({ queryKey: qkSettings.llmProviderPreferences() });
        qc.invalidateQueries({ queryKey: qkSettings.models() });
      }
    },
  });
}

// ── Teams ────────────────────────────────────────────────────────────────

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation<CreateTeamResponse, Error, CreateTeamRequest>({
    mutationFn: (body) => api.createTeam(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteTeam(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}


export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; body: AddTeamMemberRequest }>({
    mutationFn: ({ teamId, body }) => api.addTeamMember(teamId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useSetTeamMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { teamId: string; userId: string; body: SetTeamMemberRoleRequest }
  >({
    mutationFn: ({ teamId, userId, body }) => api.setTeamMemberRole(teamId, userId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
    },
  });
}

export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; userId: string }>({
    mutationFn: ({ teamId, userId }) => api.removeTeamMember(teamId, userId),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

// ── GitHub App (GitHub/repo integration plan, Task 5/11) — org-admin-only ──

export function useGithubApp(opts?: UseQueryOptions<GetGithubAppResponse>) {
  return useQuery<GetGithubAppResponse>({
    queryKey: qkSettings.githubApp(),
    queryFn: () => api.getGithubApp(),
    ...opts,
  });
}

export function useCreateGithubAppManifest() {
  return useMutation<PostGithubAppManifestResponse, Error, PostGithubAppManifestRequest | void>({
    mutationFn: (body) => api.postGithubAppManifest(body ?? {}),
    // No invalidation — nothing changes until the admin completes the
    // browser-POST manifest flow and GitHub redirects back to `GET /setup`.
  });
}

/** Connects a GitHub App that already exists. The server checks the
 * credential with GitHub before it stores anything, so a rejection here means
 * the credential is wrong, not that the save failed. */
export function useSaveGithubAppCredential() {
  const qc = useQueryClient();
  return useMutation<GetGithubAppResponse, Error, PostGithubAppCredentialRequest>({
    mutationFn: (body) => api.postGithubAppCredential(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
    },
  });
}

export function useRefreshGithubApp() {
  const qc = useQueryClient();
  return useMutation<GetGithubAppResponse, Error, void>({
    mutationFn: () => api.refreshGithubApp(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
    },
  });
}

export function useDeleteGithubApp() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, void>({
    mutationFn: () => api.deleteGithubApp(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
    },
  });
}

// ── Slack app (agent surface) — org-admin-only ─────────────────────────────

export function useSlackApp(name?: string, opts?: Partial<UseQueryOptions<GetSlackAppResponse>>) {
  return useQuery<GetSlackAppResponse>({
    queryKey: qkSettings.slackApp(name),
    queryFn: () => api.getSlackApp(name),
    ...opts,
  });
}

/** Saves the org Slack credential. The server checks the bot token with
 * Slack (`auth.test` + required scopes) before it stores anything, so a
 * rejection here means the token or secret is wrong, not that the save
 * failed. `appToken` is the app-level `xapp-` token Socket Mode ingress
 * polls with (`plugin-slack`'s `socketModePoll`); a webhook deployment has
 * no use for it. */
export function useSaveSlackCredential() {
  const qc = useQueryClient();
  return useMutation<
    PutCredentialResponse,
    Error,
    { accessToken: string; webhookSecret: string; appToken?: string }
  >({
    mutationFn: ({ accessToken, webhookSecret, appToken }) =>
      api.putCredential("slack", {
        type: "bot_token",
        accessToken,
        scope: "org",
        metadata: { webhookSecret, ...(appToken ? { appToken } : {}) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.slackAppAll() });
    },
  });
}

export function useDeleteSlackApp() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, void>({
    mutationFn: () => api.deleteCredential("slack", { scope: "org" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.slackAppAll() });
    },
  });
}

