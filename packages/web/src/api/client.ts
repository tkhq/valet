/**
 * Typed REST client. Routes are documented inline; types come from
 * `@valet/api/wire` so server + web agree on the shape.
 *
 * Auth: in dev mode, the server runs with VALET_LOCAL_AUTH=1 and accepts any
 * (or no) Authorization header. We don't ship one for now; later when real
 * auth lands we'll wire token storage here.
 */
import type {
  AddTeamMemberRequest,
  AuthConfigResponse,
  CancelWorkflowRunResponse,
  CreateSourceResponse,
  ListBakesResponse,
  ListSourcesResponse,
  PatchSourceResponse,
  TriggerBakeResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  DeleteCredentialResponse,
  EnsureOrchestratorResponse,
  GetGithubAppResponse,
  GetMemoryTreeResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  GetPrebuildForRepoResponse,
  GetReposResponse,
  GetSessionResponse,
  GetSkillResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListCredentialsResponse,
  ListDecisionsResponse,
  ListIdentityLinksResponse,
  ListInvitesResponse,
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  GetLlmProviderPreferencesResponse,
  ListLlmProvidersResponse,
  ListMessagesResponse,
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListModelsResponse,
  ListPluginsResponse,
  ListSessionsResponse,
  ListSkillsResponse,
  CreateSkillRequest,
  UpdateSkillRequest,
  SkillResponse,
  DeleteSkillResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  ListThreadsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowVersionsResponse,
  GetWorkflowVersionResponse,
  ListWorkflowsResponse,
  MeResponse,
  OrgMembersResponse,
  OrgResponse,
  PatchLlmProviderRequest,
  PatchLlmProviderResponse,
  PatchMeRequest,
  PatchMeResponse,
  PatchOrchestratorInfoRequest,
  PatchOrchestratorInfoResponse,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchIdentityLinkRequest,
  PatchOrgRequest,
  PatchOrgResponse,
  PatchSessionRequest,
  PatchSessionResponse,
  PauseSessionResponse,
  PatchThreadRequest,
  PatchThreadResponse,
  PostGithubAppManifestRequest,
  PostGithubAppManifestResponse,
  PostGithubConnectResponse,
  OpenrouterRegistryResponse,
  ProbeLlmProviderResponse,
  PutCredentialRequest,
  PutCredentialResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  PutLlmProviderPreferencesRequest,
  PutLlmProviderPreferencesResponse,
  ResolveDecisionRequest,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  RevokeInviteResponse,
  SandboxJwtResponse,
  SendPromptRequest,
  SendPromptResponse,
  SetNotificationPreferenceRequest,
  StartIdentityLinkResponse,
  SetTeamMemberRoleRequest,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  TestLlmProviderRequest,
  TestLlmProviderResponse,
  UpdateWorkflowRequest,
  UsageSummaryResponse,
  UpdateWorkflowResponse,
  WithdrawDecisionRequest,
} from "@valet/api/wire";
import type {
  ExportMemoryResponse,
  GetMemoryDocResponse,
  ImportMemoryRequest,
  ImportMemoryResponse,
  MemoryGraphResponse,
  SearchMemoryResponse,
} from "./memory-types";

const BASE = "/api"; // Vite proxies /api → server; same in production.

class ApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

// `GET /api/auth-config` is unauthenticated and doesn't change without a
// server restart — fetched once and cached, shared by `useAuthConfig`
// (login/signup control rendering) and the 401 guard below.
let cachedAuthConfig: AuthConfigResponse | null = null;
let authConfigPromise: Promise<AuthConfigResponse> | null = null;

async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  if (cachedAuthConfig) return cachedAuthConfig;
  if (!authConfigPromise) {
    authConfigPromise = fetch(`${BASE}/auth-config`)
      .then((res) => res.json() as Promise<AuthConfigResponse>)
      .then((cfg) => {
        cachedAuthConfig = cfg;
        return cfg;
      })
      .catch((err) => {
        authConfigPromise = null;
        throw err;
      });
  }
  return authConfigPromise;
}

const AUTH_ROUTES = new Set(["/login", "/signup"]);
let redirectingToLogin = false;

/**
 * Central 401 → `/login` redirect. `stub: true` (dev, `VALET_LOCAL_AUTH=1`)
 * never redirects — behavior there is unchanged. Guarded by
 * `redirectingToLogin` so a burst of concurrent 401s (several in-flight
 * queries after a session expires) triggers exactly one navigation, not a
 * per-request storm.
 */
async function maybeRedirectToLogin(): Promise<void> {
  if (redirectingToLogin) return;
  if (AUTH_ROUTES.has(window.location.pathname)) return;
  const cfg = await fetchAuthConfig();
  if (cfg.stub) return;
  redirectingToLogin = true;
  window.location.href = "/login";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (res.status === 401) {
      void maybeRedirectToLogin();
    }
    throw new ApiError(res.status, `${method} ${path} → ${res.status}`, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // auth
  getAuthConfig: () => fetchAuthConfig(),

  // sessions
  listSessions: () => request<ListSessionsResponse>("GET", "/sessions"),
  getSession: (id: string) =>
    request<GetSessionResponse>("GET", `/sessions/${encodeURIComponent(id)}`),
  createSession: (body: CreateSessionRequest) =>
    request<CreateSessionResponse>("POST", "/sessions", body),
  deleteSession: (id: string) =>
    request<{ ok: true }>("DELETE", `/sessions/${encodeURIComponent(id)}`),
  patchSession: (id: string, body: PatchSessionRequest) =>
    request<PatchSessionResponse>("PATCH", `/sessions/${encodeURIComponent(id)}`, body),
  mintSandboxJwt: (id: string) =>
    request<SandboxJwtResponse>("POST", `/sessions/${encodeURIComponent(id)}/sandbox-jwt`),
  pauseSession: (id: string) =>
    request<PauseSessionResponse>("POST", `/sessions/${encodeURIComponent(id)}/pause`),
  autoTitleSession: (id: string, threadId?: string) => {
    const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    return request<{ sessionTitle: string | null; threadTitle: string | null }>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/auto-title${qs}`,
    );
  },

  // orchestrator (session ids contain colons — always encoded above too, but
  // this entry point never touches a raw id itself, only ensures one exists)
  ensureOrchestrator: () =>
    request<EnsureOrchestratorResponse>("POST", "/orchestrator"),
  getOrchestratorInfo: () =>
    request<GetOrchestratorInfoResponse>("GET", "/orchestrator/info"),
  patchOrchestratorInfo: (body: PatchOrchestratorInfoRequest) =>
    request<PatchOrchestratorInfoResponse>("PATCH", "/orchestrator/info", body),
  getOrchestratorChildren: () =>
    request<GetOrchestratorChildrenResponse>("GET", "/orchestrator/children"),

  // memory (assistant-centered web UI decision 7; dashboard memory card +
  // the Task 6 explorer share these reads)
  getMemoryTree: () => request<GetMemoryTreeResponse>("GET", "/memory/tree"),
  getMemoryDoc: (path: string) =>
    request<GetMemoryDocResponse>("GET", `/memory?path=${encodeURIComponent(path)}`),
  searchMemory: (q: string) =>
    request<SearchMemoryResponse>("GET", `/memory/search?q=${encodeURIComponent(q)}`),
  getMemoryGraph: () => request<MemoryGraphResponse>("GET", "/memory/graph"),
  writeMemoryDoc: (body: { path: string; content: string }) =>
    request<unknown>("PUT", "/memory", body),
  deleteMemoryDoc: (path: string) =>
    request<unknown>("DELETE", `/memory?path=${encodeURIComponent(path)}`),
  exportMemory: () => request<ExportMemoryResponse>("GET", "/memory/export"),
  importMemory: (body: ImportMemoryRequest) =>
    request<ImportMemoryResponse>("POST", "/memory/import", body),

  // threads + messages (session-scoped)
  listThreads: (sessionId: string) =>
    request<ListThreadsResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/threads`),
  createThread: (sessionId: string, body: CreateThreadRequest = {}) =>
    request<CreateThreadResponse>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/threads`,
      body,
    ),
  patchThread: (sessionId: string, threadId: string, body: PatchThreadRequest) =>
    request<PatchThreadResponse>(
      "PATCH",
      `/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}`,
      body,
    ),
  listMessages: (
    sessionId: string,
    opts?: { limit?: number; cursor?: string; threadId?: string },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.threadId) qs.set("threadId", opts.threadId);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListMessagesResponse>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/messages${tail}`,
    );
  },
  sendPrompt: (sessionId: string, body: SendPromptRequest) =>
    request<SendPromptResponse>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      body,
    ),
  abortThread: (sessionId: string, threadId: string) =>
    request<{ ok: true }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}/abort`,
    ),

  // decision gates
  listDecisions: (sessionId: string) =>
    request<ListDecisionsResponse>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/decisions`,
    ),
  resolveDecision: (
    sessionId: string,
    gateId: string,
    body: ResolveDecisionRequest,
  ) =>
    request<{ ok: true }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(gateId)}/resolve`,
      body,
    ),
  withdrawDecision: (
    sessionId: string,
    gateId: string,
    body: WithdrawDecisionRequest = {},
  ) =>
    request<{ ok: true }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(gateId)}/withdraw`,
      body,
    ),

  // notifications
  listNotifications: (opts?: { unread?: boolean }) =>
    request<ListNotificationsResponse>(
      "GET",
      `/notifications${opts?.unread ? "?unread=1" : ""}`,
    ),
  markNotificationRead: (id: string) =>
    request<{ ok: true }>("POST", `/notifications/${encodeURIComponent(id)}/read`),
  markAllNotificationsRead: () =>
    request<{ ok: true }>("POST", "/notifications/read-all"),
  listNotificationPreferences: () =>
    request<ListNotificationPreferencesResponse>("GET", "/notifications/preferences"),
  setNotificationPreference: (body: SetNotificationPreferenceRequest) =>
    request<{ ok: true }>("PUT", "/notifications/preferences", body),

  // workflows (engine v2 Phase 5 decision 19)
  listWorkflows: () => request<ListWorkflowsResponse>("GET", "/workflows"),
  getWorkflow: (id: string) =>
    request<GetWorkflowResponse>("GET", `/workflows/${encodeURIComponent(id)}`),
  createWorkflow: (body: CreateWorkflowRequest) =>
    request<CreateWorkflowResponse>("POST", "/workflows", body),
  updateWorkflow: (id: string, body: UpdateWorkflowRequest) =>
    request<UpdateWorkflowResponse>("PUT", `/workflows/${encodeURIComponent(id)}`, body),
  deleteWorkflow: (id: string) =>
    request<{ ok: true }>("DELETE", `/workflows/${encodeURIComponent(id)}`),
  startWorkflowRun: (id: string, body: StartWorkflowRunRequest = {}) =>
    request<StartWorkflowRunResponse>(
      "POST",
      `/workflows/${encodeURIComponent(id)}/runs`,
      body,
    ),
  listWorkflowRuns: (id: string) =>
    request<ListWorkflowRunsResponse>("GET", `/workflows/${encodeURIComponent(id)}/runs`),
  listWorkflowVersions: (id: string) =>
    request<ListWorkflowVersionsResponse>("GET", `/workflows/${encodeURIComponent(id)}/versions`),
  getWorkflowVersion: (id: string, version: number) =>
    request<GetWorkflowVersionResponse>(
      "GET",
      `/workflows/${encodeURIComponent(id)}/versions/${version}`,
    ),
  getWorkflowRun: (runId: string) =>
    request<GetWorkflowRunResponse>("GET", `/workflows/runs/${encodeURIComponent(runId)}`),
  resolveWorkflowApproval: (
    runId: string,
    nodeId: string,
    body: ResolveWorkflowApprovalRequest,
  ) =>
    request<ResolveWorkflowApprovalResponse>(
      "POST",
      `/workflows/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}`,
      body,
    ),
  cancelWorkflowRun: (runId: string) =>
    request<CancelWorkflowRunResponse>(
      "POST",
      `/workflows/runs/${encodeURIComponent(runId)}/cancel`,
    ),

  // settings shell (split-settings design): per-user profile, org, models
  getMe: () => request<MeResponse>("GET", "/me"),
  patchMe: (body: PatchMeRequest) => request<PatchMeResponse>("PATCH", "/me", body),
  listModels: () => request<ListModelsResponse>("GET", "/models"),
  getUsageSummary: () => request<UsageSummaryResponse>("GET", "/usage/summary"),
  getJournalSummary: () =>
    request<{ date: string; summary: string | null }>("GET", "/memory/journal-summary"),
  getOrg: () => request<OrgResponse>("GET", "/org"),
  patchOrg: (body: PatchOrgRequest) => request<PatchOrgResponse>("PATCH", "/org", body),
  getOrgMembers: () => request<OrgMembersResponse>("GET", "/org/members"),
  patchOrgMember: (userId: string, body: PatchOrgMemberRequest) =>
    request<PatchOrgMemberResponse>(
      "PATCH",
      `/org/members/${encodeURIComponent(userId)}`,
      body,
    ),

  // org LLM providers (llm-providers design: provider CRUD, key mgmt,
  // custom-provider probe/test, model preferences)
  listLlmProviders: () => request<ListLlmProvidersResponse>("GET", "/org/llm-providers"),
  createLlmProvider: (body: CreateLlmProviderRequest) =>
    request<CreateLlmProviderResponse>("POST", "/org/llm-providers", body),
  patchLlmProvider: (id: string, body: PatchLlmProviderRequest) =>
    request<PatchLlmProviderResponse>(
      "PATCH",
      `/org/llm-providers/${encodeURIComponent(id)}`,
      body,
    ),
  deleteLlmProvider: (id: string) =>
    request<undefined>("DELETE", `/org/llm-providers/${encodeURIComponent(id)}`),
  putLlmProviderKey: (id: string, body: PutLlmProviderKeyRequest) =>
    request<PutLlmProviderKeyResponse>(
      "PUT",
      `/org/llm-providers/${encodeURIComponent(id)}/key`,
      body,
    ),
  deleteLlmProviderKey: (id: string) =>
    request<undefined>("DELETE", `/org/llm-providers/${encodeURIComponent(id)}/key`),
  probeLlmProvider: (id: string) =>
    request<ProbeLlmProviderResponse>("POST", `/org/llm-providers/${encodeURIComponent(id)}/probe`),
  openrouterRegistry: () =>
    request<OpenrouterRegistryResponse>("GET", "/org/llm-providers/openrouter/models"),
  testLlmProvider: (id: string, body: TestLlmProviderRequest) =>
    request<TestLlmProviderResponse>(
      "POST",
      `/org/llm-providers/${encodeURIComponent(id)}/test`,
      body,
    ),
  getLlmProviderPreferences: () =>
    request<GetLlmProviderPreferencesResponse>("GET", "/org/llm-providers/preferences"),
  putLlmProviderPreferences: (body: PutLlmProviderPreferencesRequest) =>
    request<PutLlmProviderPreferencesResponse>("PUT", "/org/llm-providers/preferences", body),

  // org invites (org-admin only)
  listInvites: () => request<ListInvitesResponse>("GET", "/org/invites"),
  createInvite: (body: CreateInviteRequest) =>
    request<CreateInviteResponse>("POST", "/org/invites", body),
  revokeInvite: (id: string) =>
    request<RevokeInviteResponse>("DELETE", `/org/invites/${encodeURIComponent(id)}`),

  // teams (org membership structure — first UI over the existing router)
  listTeams: () => request<ListTeamsResponse>("GET", "/teams"),
  createTeam: (body: CreateTeamRequest) =>
    request<CreateTeamResponse>("POST", "/teams", body),
  deleteTeam: (id: string) =>
    request<{ ok: true }>("DELETE", `/teams/${encodeURIComponent(id)}`),
  listTeamMembers: (id: string) =>
    request<ListTeamMembersResponse>("GET", `/teams/${encodeURIComponent(id)}/members`),
  addTeamMember: (id: string, body: AddTeamMemberRequest) =>
    request<{ ok: true }>("POST", `/teams/${encodeURIComponent(id)}/members`, body),
  setTeamMemberRole: (id: string, userId: string, body: SetTeamMemberRoleRequest) =>
    request<{ ok: true }>(
      "PATCH",
      `/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      body,
    ),
  removeTeamMember: (id: string, userId: string) =>
    request<{ ok: true }>(
      "DELETE",
      `/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    ),

  // plugins + credentials (plugin-system-v2 plan Task 15 — connect surface)
  listPlugins: () => request<ListPluginsResponse>("GET", "/plugins"),
  listCredentials: () => request<ListCredentialsResponse>("GET", "/credentials"),
  putCredential: (service: string, body: PutCredentialRequest) =>
    request<PutCredentialResponse>(
      "PUT",
      `/credentials/${encodeURIComponent(service)}`,
      body,
    ),
  deleteCredential: (service: string) =>
    request<DeleteCredentialResponse>(
      "DELETE",
      `/credentials/${encodeURIComponent(service)}`,
    ),

  // skills — the markdown playbooks the agent reads. The catalog mixes the
  // plugin-supplied ones with the stored ones the caller owns; only stored
  // skills can be written, and they are addressed by row id because a
  // shadowed skill shares its name with the skill that shadows it.
  listSkills: () => request<ListSkillsResponse>("GET", "/skills"),
  getSkill: (name: string) =>
    request<GetSkillResponse>("GET", `/skills/${encodeURIComponent(name)}`),
  getStoredSkill: (id: string) =>
    request<SkillResponse>("GET", `/skills/stored/${encodeURIComponent(id)}`),
  createSkill: (body: CreateSkillRequest) => request<SkillResponse>("POST", "/skills", body),
  updateSkill: (id: string, body: UpdateSkillRequest) =>
    request<SkillResponse>("PATCH", `/skills/stored/${encodeURIComponent(id)}`, body),
  deleteSkill: (id: string) =>
    request<DeleteSkillResponse>("DELETE", `/skills/stored/${encodeURIComponent(id)}`),

  // repos (GitHub/repo integration plan, Task 7): union of every RepoHost
  // the caller has access to — only `github` today.
  getRepos: () => request<GetReposResponse>("GET", "/repos"),

  getPrebuildForRepo: (fullName: string) =>
    request<GetPrebuildForRepoResponse>(
      "GET",
      `/sources/for-repo?fullName=${encodeURIComponent(fullName)}`,
    ),

  // sandbox image sources (sandbox-reconciliation plan, Task 18): org-admin
  // CRUD for all source kinds (external/base/repo) and bake history.
  listSources: () => request<ListSourcesResponse>("GET", "/org/sources"),
  createSource: (body: Record<string, unknown>) => request<CreateSourceResponse>("POST", "/org/sources", body),
  patchSource: (id: string, body: Record<string, unknown>) =>
    request<PatchSourceResponse>("PATCH", `/org/sources/${encodeURIComponent(id)}`, body),
  deleteSource: (id: string) => request<{ ok: true }>("DELETE", `/org/sources/${encodeURIComponent(id)}`),
  bakeSource: (id: string) => request<TriggerBakeResponse>("POST", `/org/sources/${encodeURIComponent(id)}/bake`),
  listSourceBakes: (id: string) => request<ListBakesResponse>("GET", `/org/sources/${encodeURIComponent(id)}/bakes`),

  // org GitHub App setup (GitHub/repo integration plan, Task 5) — admin-gated
  getGithubApp: () => request<GetGithubAppResponse>("GET", "/org/github-app"),
  postGithubAppManifest: (body: PostGithubAppManifestRequest = {}) =>
    request<PostGithubAppManifestResponse>("POST", "/org/github-app/manifest", body),
  refreshGithubApp: () => request<GetGithubAppResponse>("POST", "/org/github-app/refresh"),
  deleteGithubApp: () => request<undefined>("DELETE", "/org/github-app"),

  // per-user GitHub App-OAuth connection (GitHub/repo integration plan, Task 6)
  connectGithub: () => request<PostGithubConnectResponse>("POST", "/me/github/connect"),
  disconnectGithub: () => request<undefined>("DELETE", "/me/github"),

  // identity links (channel-link Phase 7): per-user Telegram account linking
  listIdentityLinks: () => request<ListIdentityLinksResponse>("GET", "/me/identity-links"),
  startIdentityLink: (provider: string) =>
    request<StartIdentityLinkResponse>(
      "POST",
      `/me/identity-links/${encodeURIComponent(provider)}/start`,
    ),
  patchIdentityLink: (provider: string, body: PatchIdentityLinkRequest) =>
    request<{ ok: true }>("PATCH", `/me/identity-links/${encodeURIComponent(provider)}`, body),
  deleteIdentityLink: (provider: string) =>
    request<{ ok: true }>("DELETE", `/me/identity-links/${encodeURIComponent(provider)}`),
};

export { ApiError };
