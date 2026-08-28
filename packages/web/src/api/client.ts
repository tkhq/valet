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
  CreateAssistantRequest,
  CreateAssistantResponse,
  EnsureAssistantSessionResponse,
  ListAssistantsResponse,
  PatchAssistantRequest,
  PatchAssistantResponse,
  AllowWorkflowPermissionsRequest,
  AllowWorkflowPermissionsResponse,
  CancelWorkflowRunResponse,
  DeleteWorkflowWebhookResponse,
  GetWorkflowPermissionsResponse,
  WorkflowWebhookResponse,
  CreateSourceResponse,
  ListBakesResponse,
  ListSourcesResponse,
  PatchSourceResponse,
  TriggerBakeResponse,
  CreateOrgPolicyRequest,
  CreateOrgPolicyResponse,
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
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  DeleteCredentialResponse,
  DeleteGrantRequest,
  DeleteGrantResponse,
  DeleteOrgPolicyResponse,
  DeletePolicyOverrideRequest,
  DeletePolicyOverrideResponse,
  EnsureOrchestratorResponse,
  GetArtifactResponse,
  GetGithubAppResponse,
  GetGithubOrgStatusResponse,
  GetMemoryTreeResponse,
  ListArtifactsResponse,
  PatchArtifactRequest,
  PatchArtifactResponse,
  ShareArtifactRequest,
  ShareArtifactResponse,
  OrgSettingsResponse,
  PatchOrgSettingsRequest,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  GetPrebuildForRepoResponse,
  GetReposResponse,
  GetSlackAppResponse,
  GetWorkflowImportFileResponse,
  GetSessionResponse,
  GetSessionSecurityResponse,
  GetSkillResponse,
  ListSecurityCoverageResponse,
  ListSecurityFindingsResponse,
  SecurityAddFindingCommentResponse,
  SecurityDigestIssueResponse,
  SecurityFileIssueResponse,
  SecurityFindingSeverity,
  SecurityFindingStatus,
  SecurityPlanCellInput,
  SecurityResolveNeedsResponse,
  SecurityReviewFindingResponse,
  SecuritySetConfigResponse,
  SecuritySetPlanResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  GetWorkflowTriggerCatalogResponse,
  DeliverIdentityLinkFallback,
  DeliverIdentityLinkRequest,
  DeliverIdentityLinkResponse,
  ListLinkMembersResponse,
  ListCredentialsResponse,
  ListActionLogResponse,
  ListDecisionsResponse,
  ListGrantsResponse,
  ListIdentityLinksResponse,
  ListInvitesResponse,
  ListAllWorkflowRunsResponse,
  ListOrgPoliciesResponse,
  ListPolicyOverridesResponse,
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
  ListSkillSourcesResponse,
  CreateSkillSourceRequest,
  SkillSourceSyncResponse,
  DeleteSkillSourceResponse,
  SkillResponse,
  DeleteSkillResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  ListThreadsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ListWorkflowVersionsResponse,
  GetWorkflowVersionResponse,
  ListWorkflowsResponse,
  ListWorkflowTemplatesResponse,
  InstallWorkflowTemplateRequest,
  InstallWorkflowTemplateResponse,
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
  PatchOrgPolicyRequest,
  PatchOrgPolicyResponse,
  PatchOrgRequest,
  PatchOrgResponse,
  PatchSessionRequest,
  PatchSessionResponse,
  PauseSessionResponse,
  SessionKind,
  PatchThreadRequest,
  PatchThreadResponse,
  PostGithubAppCredentialRequest,
  PostGithubAppManifestRequest,
  PostGithubAppManifestResponse,
  PostGithubConnectResponse,
  OpenrouterRegistryResponse,
  PreviewOrgPolicyRequest,
  PreviewOrgPolicyResponse,
  ProbeLlmProviderResponse,
  PutCredentialRequest,
  PutCredentialResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  PutLlmProviderPreferencesRequest,
  PutLlmProviderPreferencesResponse,
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
  PutPolicyOverrideRequest,
  PutPolicyOverrideResponse,
  RedeliverEventResponse,
  ResolveDecisionRequest,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  RetryWorkflowRunResponse,
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
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowRequest,
  UpdateWorkflowScheduleRequest,
  UsageSummaryResponse,
  UpdateWorkflowResponse,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
  WithdrawDecisionRequest,
  ListCommandsResponse,
  ProxyUsageSummary,
  ProxyRequestDetail,
  ProxyRequestListItem,
  ProxySettingsResponse,
  UsageBreakdownResponse,
  UsageSessionsResponse,
  UsageDrillResponse,
  UsageDrillItem,
  UsageUseCase,
} from "@valet/api/wire";
import type {
  ExportMemoryResponse,
  GetMemoryDocResponse,
  ImportMemoryRequest,
  ImportMemoryResponse,
  MemoryGraphResponse,
  SearchMemoryResponse,
} from "./memory-types";
import { safeNextPath } from "~/lib/next-path";

const BASE = "/api"; // Vite proxies /api → server; same in production.

/**
 * One workspace, as the list endpoints take it.
 *
 * `undefined` means "do not narrow", which is not the same as the personal
 * workspace: unnarrowed lists return the caller's own rows AND every team's
 * they belong to. The personal workspace is `{ ownerType: "user", ownerId:
 * <the caller's id> }`.
 */
export interface OwnerFilter {
  ownerType: "user" | "team" | "org";
  ownerId: string;
}

/** The owner pair, encoded, with NO leading separator.
 *
 * Split out from `ownerQuery` because two memory endpoints already carry a
 * query string and need `&`. Serialising them by hand instead skipped
 * encoding, and would have drifted the moment this format changed. */
function ownerParams(owner: OwnerFilter | undefined): string {
  if (!owner) return "";
  return new URLSearchParams({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  }).toString();
}

/** `?ownerType=&ownerId=`, or empty. The server rejects a half-specified
 * pair, so both are written or neither is. */
function ownerQuery(owner: OwnerFilter | undefined): string {
  const params = ownerParams(owner);
  return params ? `?${params}` : "";
}

/** The owner pair appended to a path that ALREADY has a query string. */
function ownerSuffix(owner: OwnerFilter | undefined): string {
  const params = ownerParams(owner);
  return params ? `&${params}` : "";
}

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
  // Carry the interrupted location so sign-in lands back here — the whole
  // point for a shared `/a/{token}` link. The login page re-validates the
  // value (`safeNextPath`), so a stale or mangled path degrades to "/".
  const next = safeNextPath(window.location.pathname + window.location.search);
  window.location.href = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/**
 * The deadline every REST call gets.
 *
 * `fetch` has no timeout of its own. A request that is lost — the server
 * stopped mid-response, or a socket that never answers — leaves its promise
 * pending for the life of the page. That is worse than an error, because a
 * caller which remembers the in-flight promise to avoid duplicate work then
 * hands the same dead promise to every later caller and never retries. A
 * rejection is recoverable. A promise that never settles is not.
 *
 * 30s is above the slowest normal call (a cold sandbox start) and far below
 * a person's patience for a spinner that will never stop.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Status for a request that never reached a response. Distinct from any
 * HTTP status, because no server replied. */
const NO_RESPONSE_STATUS = 0;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // The signal also covers reading the body below, so a response whose
      // stream stalls part way is cut off on the same deadline.
      signal: controller.signal,
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
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError(
        NO_RESPONSE_STATUS,
        `${method} ${path} got no response in ${REQUEST_TIMEOUT_MS / 1000}s. Check that the server is running, then try again.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Keyset paging for the run lists. `cursor` is a page's `nextCursor`. */
export interface WorkflowRunPage {
  limit?: number;
  cursor?: string;
}

/**
 * What the two Library listings take. Both page the same way — `cursor` is a
 * page's `nextCursor`, never a value the client builds — and both accept the
 * owner pin.
 *
 * The catalog's own controls ride here too, because the server applies them:
 * a chip or a search box that filtered the page in hand would answer about
 * that page while claiming to answer about the library.
 */
export interface SkillListQuery {
  ownerType?: "user" | "team" | "org";
  ownerId?: string;
  scope?: "personal" | "team" | "org" | "plugin";
  kind?: "skill" | "prompt";
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface SkillSourceListQuery {
  ownerType?: "user" | "team" | "org";
  ownerId?: string;
  /** Drop org rows from the unfiltered union. `/skills` sends this so org
   * repositories stay on Organization · Library. Do not send it with an
   * owner pin. */
  excludeOrg?: boolean;
  limit?: number;
  cursor?: string;
}

/** Filters + cursor page the security findings list accepts. Mirrors the
 * route's query params (`GET /sessions/:id/security/findings`). */
export interface SecurityFindingsQuery {
  severity?: SecurityFindingSeverity;
  status?: SecurityFindingStatus;
  cellId?: string;
  path?: string;
  cursor?: string;
  limit?: number;
}

/** Filters the cross-workflow run list accepts. Array fields match any-of. */
export interface WorkflowRunFilter extends WorkflowRunPage {
  workflowIds?: string[];
  status?: WorkflowRunStatus[];
  outcome?: WorkflowRunOutcome[];
  parentRunId?: string;
  since?: number;
}

export const api = {
  // auth
  getAuthConfig: () => fetchAuthConfig(),

  // sessions
  /** Unscoped lists the caller's own sessions plus every team's they can
   * reach. `owner` narrows it to one workspace; `kind` to one session kind
   * (the security hub sends `kind=security`). */
  listSessions: (owner?: OwnerFilter, kind?: SessionKind) =>
    request<ListSessionsResponse>(
      "GET",
      kind ? `/sessions?kind=${kind}${ownerSuffix(owner)}` : `/sessions${ownerQuery(owner)}`,
    ),
  getSession: (id: string) =>
    request<GetSessionResponse>("GET", `/sessions/${encodeURIComponent(id)}`),
  /** GET /sessions/:id/security — the session's engagement + cells
   * (valet-security design §Web Surfaces). 404s for a non-security session. */
  getSessionSecurity: (id: string) =>
    request<GetSessionSecurityResponse>("GET", `/sessions/${encodeURIComponent(id)}/security`),
  /** GET /sessions/:id/security/findings — filtered, cursor-paginated
   * (valet-security design §Findings review). */
  listSecurityFindings: (id: string, params: SecurityFindingsQuery = {}) => {
    const qs = new URLSearchParams();
    if (params.severity) qs.set("severity", params.severity);
    if (params.status) qs.set("status", params.status);
    if (params.cellId) qs.set("cellId", params.cellId);
    if (params.path) qs.set("path", params.path);
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return request<ListSecurityFindingsResponse>(
      "GET",
      `/sessions/${encodeURIComponent(id)}/security/findings${suffix}`,
    );
  },
  /** GET /sessions/:id/security/coverage — the coverage ledger (NOT_ASSESSED,
   * M-P2d): every coverage row + the assessed/not_assessed rollup with gaps. */
  getSecurityCoverage: (id: string) =>
    request<ListSecurityCoverageResponse>(
      "GET",
      `/sessions/${encodeURIComponent(id)}/security/coverage`,
    ),
  /** POST /sessions/:id/security/plan/cells — replace the plan from structured
   * steps during planning (dynamic-config M-F2; session admin). The server
   * assigns dense ordinals in array order. Returns the new cell count. */
  setSecurityPlanCells: (id: string, cells: SecurityPlanCellInput[]) =>
    request<SecuritySetPlanResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/plan/cells`,
      { cells },
    ),
  /** POST /sessions/:id/security/config — edit the engagement's focus, known
   * invariants, and loaded threat categories during planning (dynamic-config
   * M-F3, M-P2a; session admin). Returns the saved values. */
  setSecurityConfig: (
    id: string,
    body: { focus?: string | null; invariants?: string[]; categories?: string[] },
  ) =>
    request<SecuritySetConfigResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/config`,
      body,
    ),
  /** POST /sessions/:id/security/findings/:findingId/status — human
   * verify/refute (forward-only; session admin). */
  reviewSecurityFinding: (
    id: string,
    findingId: string,
    body: { status: "verified" | "refuted"; reason: string },
  ) =>
    request<SecurityReviewFindingResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/findings/${encodeURIComponent(findingId)}/status`,
      body,
    ),
  /** POST /sessions/:id/security/findings/:findingId/comments — add a human
   * note to a finding (view-gated; human-only). Returns the created comment. */
  addSecurityFindingComment: (id: string, findingId: string, body: { body: string }) =>
    request<SecurityAddFindingCommentResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/findings/${encodeURIComponent(findingId)}/comments`,
      body,
    ),
  /** POST /sessions/:id/security/findings/:findingId/issues — file one
   * GitHub/Linear issue; idempotent per (finding, provider). */
  fileSecurityIssue: (
    id: string,
    findingId: string,
    body: { provider: "github" | "linear"; repo?: string; teamId?: string },
  ) =>
    request<SecurityFileIssueResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/findings/${encodeURIComponent(findingId)}/issues`,
      body,
    ),
  /** POST /sessions/:id/security/issues/digest — one digest issue from many
   * findings; writes no link rows. */
  fileSecurityDigest: (
    id: string,
    body: { provider: "github" | "linear"; findingIds: string[]; repo?: string; teamId?: string },
  ) =>
    request<SecurityDigestIssueResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/issues/digest`,
      body,
    ),
  /** POST /sessions/:id/security/cancel — stop a planning or running
   * engagement (human action; session admin). Returns the cancelled
   * engagement + cells. */
  cancelSecurityReview: (id: string) =>
    request<GetSessionSecurityResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/cancel`,
    ),
  /** POST /sessions/:id/security/needs/resolve — the consolidated human answer
   * + delta re-run (pivot-coordinator, M-P4c; session admin). Marks each need
   * answered and resets only the affected cells to pending. */
  resolveSecurityNeeds: (
    id: string,
    answers: { needId: string; resolution: string; dismiss?: boolean }[],
  ) =>
    request<SecurityResolveNeedsResponse>(
      "POST",
      `/sessions/${encodeURIComponent(id)}/security/needs/resolve`,
      { answers },
    ),
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
  replaceSandbox: (id: string) =>
    request<{ ok: true }>("POST", `/sessions/${encodeURIComponent(id)}/sandbox/replace`),
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
  dismissChild: (childSessionId: string) =>
    request<{ ok: true }>(
      "POST",
      `/orchestrator/children/${encodeURIComponent(childSessionId)}/dismiss`,
    ),

  // assistants (`docs/specs/2026-08-13-assistants-design.md`). The list is
  // also how the client learns each assistant's session id, so it replaces
  // the client-side id derivation the rail used to do.
  listAssistants: () => request<ListAssistantsResponse>("GET", "/assistants"),
  createAssistant: (body: CreateAssistantRequest) =>
    request<CreateAssistantResponse>("POST", "/assistants", body),
  patchAssistant: (id: string, body: PatchAssistantRequest) =>
    request<PatchAssistantResponse>("PATCH", `/assistants/${encodeURIComponent(id)}`, body),
  // Archive, not destroy: the row keeps `archived_at` and the conversation
  // it held survives. `DELETE` carries it because the wire's
  // `PatchAssistantRequest` covers `name` and `isDefault` only, and the
  // house convention for a soft remove is the same verb as `deleteTeam`.
  archiveAssistant: (id: string) =>
    request<{ ok: true }>("DELETE", `/assistants/${encodeURIComponent(id)}`),
  /** Get-or-create one assistant's session. Creating an assistant writes no
   * session, so the chat page calls this before opening the conversation. */
  ensureAssistantSession: (id: string) =>
    request<EnsureAssistantSessionResponse>(
      "POST",
      `/assistants/${encodeURIComponent(id)}/session`,
    ),

  // memory (assistant-centered web UI decision 7; dashboard memory card +
  // the Task 6 explorer share these reads)
  /** Unscoped reads the caller's own memory. `owner` reads one workspace's
   * — a team's memory is the team's, not a view of yours. */
  getMemoryTree: (owner?: OwnerFilter) =>
    request<GetMemoryTreeResponse>("GET", `/memory/tree${ownerQuery(owner)}`),

  // artifacts (artifacts design). `getArtifact` is the token-addressed
  // read the public `/a/$token` page uses — org-visibility artifacts 401
  // for signed-out callers, which the central 401 redirect handles.
  getArtifact: (token: string) =>
    request<GetArtifactResponse>("GET", `/artifacts/${encodeURIComponent(token)}`),
  shareArtifact: (body: ShareArtifactRequest) =>
    request<ShareArtifactResponse>("POST", "/artifacts/share", body),
  listArtifacts: () => request<ListArtifactsResponse>("GET", "/artifacts"),
  patchArtifact: (id: string, body: PatchArtifactRequest) =>
    request<PatchArtifactResponse>("PATCH", `/artifacts/${encodeURIComponent(id)}`, body),
  revokeArtifact: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/artifacts/${encodeURIComponent(id)}`),
  patchOrgSettings: (body: PatchOrgSettingsRequest) =>
    request<OrgSettingsResponse>("PATCH", "/org/settings", body),
  getMemoryDoc: (path: string, owner?: OwnerFilter) =>
    request<GetMemoryDocResponse>(
      "GET",
      `/memory?path=${encodeURIComponent(path)}${ownerSuffix(owner)}`,
    ),
  searchMemory: (q: string, owner?: OwnerFilter) =>
    request<SearchMemoryResponse>(
      "GET",
      `/memory/search?q=${encodeURIComponent(q)}${ownerSuffix(owner)}`,
    ),
  getMemoryGraph: (owner?: OwnerFilter) =>
    request<MemoryGraphResponse>("GET", `/memory/graph${ownerQuery(owner)}`),
  // `content` and `pinned` are both optional: the route leaves the body
  // alone when `content` is absent, which is how the doc view pins a file
  // without rewriting it.
  writeMemoryDoc: (body: { path: string; content?: string; pinned?: boolean }, owner?: OwnerFilter) =>
    request<unknown>("PUT", `/memory${ownerQuery(owner)}`, body),
  deleteMemoryDoc: (path: string, owner?: OwnerFilter) =>
    request<unknown>("DELETE", `/memory?path=${encodeURIComponent(path)}${ownerSuffix(owner)}`),
  exportMemory: () => request<ExportMemoryResponse>("GET", "/memory/export"),
  importMemory: (body: ImportMemoryRequest) =>
    request<ImportMemoryResponse>("POST", "/memory/import", body),

  // threads + messages (session-scoped)
  listThreads: (sessionId: string, opts?: { archived?: boolean }) =>
    request<ListThreadsResponse>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/threads${opts?.archived ? "?archived=1" : ""}`,
    ),
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

  // slash commands
  listCommands: (sessionId: string) =>
    request<ListCommandsResponse>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/commands`,
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
  /** Unscoped lists the caller's own workflows PLUS every team's they belong
   * to. `owner` narrows it to one workspace, which is what the workspace
   * switcher means. Both parts go together or neither: the server rejects a
   * half-specified pair rather than guessing. */
  listWorkflows: (owner?: OwnerFilter) =>
    request<ListWorkflowsResponse>("GET", `/workflows${ownerQuery(owner)}`),
  getWorkflow: (id: string) =>
    request<GetWorkflowResponse>("GET", `/workflows/${encodeURIComponent(id)}`),
  createWorkflow: (body: CreateWorkflowRequest) =>
    request<CreateWorkflowResponse>("POST", "/workflows", body),
  /** One file out of a PUBLIC GitHub repository, for the import dialog. The
   * body comes back as text: the dialog parses it with the same parser it
   * applies to a pasted file. */
  getWorkflowImportFile: (opts: { repo: string; path: string; ref?: string }) => {
    const qs = new URLSearchParams({ repo: opts.repo, path: opts.path });
    if (opts.ref) qs.set("ref", opts.ref);
    return request<GetWorkflowImportFileResponse>("GET", `/workflows/import/repo-file?${qs}`);
  },
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
  listWorkflowRuns: (id: string, opts?: WorkflowRunPage) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListWorkflowRunsResponse>(
      "GET",
      `/workflows/${encodeURIComponent(id)}/runs${tail}`,
    );
  },
  // Cross-workflow run list. `parentRunId` is how a batch parent's child
  // runs come back in one request.
  listRuns: (opts?: WorkflowRunFilter): Promise<ListWorkflowRunsResponse> => {
    // An any-of filter with no values matches nothing. A query string cannot
    // carry an empty repeated field, so an unguarded request would drop the
    // filter and list every readable run — the opposite of what was asked.
    for (const values of [opts?.workflowIds, opts?.status, opts?.outcome]) {
      if (values?.length === 0) return Promise.resolve({ runs: [] });
    }
    const qs = new URLSearchParams();
    for (const workflowId of opts?.workflowIds ?? []) qs.append("workflowId", workflowId);
    for (const status of opts?.status ?? []) qs.append("status", status);
    for (const outcome of opts?.outcome ?? []) qs.append("outcome", outcome);
    if (opts?.parentRunId) qs.set("parentRunId", opts.parentRunId);
    if (opts?.since !== undefined) qs.set("since", String(opts.since));
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListWorkflowRunsResponse>("GET", `/workflows/runs${tail}`);
  },
  getWorkflowPermissions: (id: string) =>
    request<GetWorkflowPermissionsResponse>(
      "GET",
      `/workflows/${encodeURIComponent(id)}/permissions`,
    ),
  allowWorkflowPermissions: (id: string, body: AllowWorkflowPermissionsRequest = {}) =>
    request<AllowWorkflowPermissionsResponse>(
      "POST",
      `/workflows/${encodeURIComponent(id)}/permissions/allow`,
      body,
    ),
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
  retryWorkflowRun: (runId: string) =>
    request<RetryWorkflowRunResponse>(
      "POST",
      `/workflows/runs/${encodeURIComponent(runId)}/retry`,
    ),

  // events (event-system design): org feed, per-event detail with delivery
  // attempts, the plugin trigger catalog, and subscription CRUD. Both lists
  // take an optional workspace owner.
  getEventCatalog: () => request<GetEventCatalogResponse>("GET", "/events/catalog"),
  listEvents: (params?: { service?: string; key?: string }, owner?: OwnerFilter) => {
    const qs = new URLSearchParams();
    if (params?.service) qs.set("service", params.service);
    if (params?.key) qs.set("key", params.key);
    const q = qs.toString();
    const path = q ? `/events?${q}${ownerSuffix(owner)}` : `/events${ownerQuery(owner)}`;
    return request<ListEventsResponse>("GET", path);
  },
  getEvent: (id: string) => request<GetEventResponse>("GET", `/events/${encodeURIComponent(id)}`),
  redeliverEvent: (id: string) =>
    request<RedeliverEventResponse>("POST", `/events/${encodeURIComponent(id)}/redeliver`),
  listEventSubscriptions: (owner?: OwnerFilter) =>
    request<ListEventSubscriptionsResponse>("GET", `/event-subscriptions${ownerQuery(owner)}`),
  createEventSubscription: (body: CreateEventSubscriptionRequest) =>
    request<CreateEventSubscriptionResponse>("POST", "/event-subscriptions", body),
  patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) =>
    request<PatchEventSubscriptionResponse>(
      "PATCH",
      `/event-subscriptions/${encodeURIComponent(id)}`,
      body,
    ),
  deleteEventSubscription: (id: string) =>
    request<void>("DELETE", `/event-subscriptions/${encodeURIComponent(id)}`),
  // workflow webhook URL management. Schedules and event triggers are the
  // flat trigger surface below, not this per-workflow one.
  getWorkflowWebhook: (id: string) =>
    request<WorkflowWebhookResponse>("GET", `/workflows/${encodeURIComponent(id)}/webhook`),
  mintWorkflowWebhook: (id: string) =>
    request<WorkflowWebhookResponse>("POST", `/workflows/${encodeURIComponent(id)}/webhook`),
  deleteWorkflowWebhook: (id: string) =>
    request<DeleteWorkflowWebhookResponse>("DELETE", `/workflows/${encodeURIComponent(id)}/webhook`),

  // workflow templates — the starting points the gallery on /workflows offers
  listWorkflowTemplates: () => request<ListWorkflowTemplatesResponse>("GET", "/templates"),
  installWorkflowTemplate: (id: string, body: InstallWorkflowTemplateRequest = {}) =>
    request<InstallWorkflowTemplateResponse>(
      "POST",
      `/templates/${encodeURIComponent(id)}/install`,
      body,
    ),

  // workflow triggers (spec 2026-08-15)
  listWorkflowTriggers: (workflowId?: string) =>
    request<ListWorkflowTriggersResponse>(
      "GET",
      `/workflows/triggers${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`,
    ),
  getWorkflowTriggerCatalog: () =>
    request<GetWorkflowTriggerCatalogResponse>("GET", "/workflows/trigger-catalog"),
  listAllWorkflowRuns: (limit?: number) =>
    request<ListAllWorkflowRunsResponse>("GET", `/workflows/runs${limit ? `?limit=${limit}` : ""}`),
  createWorkflowSchedule: (body: CreateWorkflowScheduleRequest) =>
    request<WorkflowScheduleResponse>("POST", "/workflows/schedules", body),
  updateWorkflowSchedule: (id: string, body: UpdateWorkflowScheduleRequest) =>
    request<WorkflowScheduleResponse>("PATCH", `/workflows/schedules/${encodeURIComponent(id)}`, body),
  deleteWorkflowSchedule: (id: string) =>
    request<{ ok: true }>("DELETE", `/workflows/schedules/${encodeURIComponent(id)}`),
  runWorkflowScheduleNow: (id: string) =>
    request<{ ok: true }>("POST", `/workflows/schedules/${encodeURIComponent(id)}/run`),
  createWorkflowEventTrigger: (body: CreateWorkflowEventTriggerRequest) =>
    request<WorkflowEventTriggerResponse>("POST", "/workflows/event-triggers", body),
  updateWorkflowEventTrigger: (id: string, body: UpdateWorkflowEventTriggerRequest) =>
    request<WorkflowEventTriggerResponse>("PATCH", `/workflows/event-triggers/${encodeURIComponent(id)}`, body),
  deleteWorkflowEventTrigger: (id: string) =>
    request<{ ok: true }>("DELETE", `/workflows/event-triggers/${encodeURIComponent(id)}`),

  // settings shell (split-settings design): per-user profile, org, models
  getMe: () => request<MeResponse>("GET", "/me"),
  patchMe: (body: PatchMeRequest) => request<PatchMeResponse>("PATCH", "/me", body),
  listModels: () => request<ListModelsResponse>("GET", "/models"),
  getUsageSummary: () => request<UsageSummaryResponse>("GET", "/usage/summary"),
  usageBreakdown: (window: string = "7d", scope: "me" | "org" = "me") => {
    const qs = new URLSearchParams({ window, scope });
    return request<UsageBreakdownResponse>("GET", `/usage/breakdown?${qs}`);
  },
  usageItems: (window: string, scope: "me" | "org", useCase: UsageUseCase) => {
    const qs = new URLSearchParams({ window, scope, useCase });
    return request<UsageDrillResponse>("GET", `/usage/items?${qs}`);
  },
  usageExportCsvUrl: (window: string, scope: "me" | "org"): string => {
    const qs = new URLSearchParams({ window, scope });
    return `/api/usage/export.csv?${qs}`;
  },
  usageSessions: (window: string = "7d", useCase?: "orchestrator" | "session") => {
    const qs = new URLSearchParams({ window });
    if (useCase) qs.set("useCase", useCase);
    return request<UsageSessionsResponse>("GET", `/usage/sessions?${qs}`);
  },
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
  ensureTeamOrchestrator: (id: string) =>
    request<EnsureOrchestratorResponse>("POST", `/teams/${encodeURIComponent(id)}/orchestrator`),

  // plugins + credentials (plugin-system-v2 plan Task 15 — connect surface)
  listPlugins: () => request<ListPluginsResponse>("GET", "/plugins"),
  listCredentials: () => request<ListCredentialsResponse>("GET", "/credentials"),
  putCredential: (service: string, body: PutCredentialRequest) =>
    request<PutCredentialResponse>(
      "PUT",
      `/credentials/${encodeURIComponent(service)}`,
      body,
    ),
  // The server defaults a missing `scope` to `"user"`; sending it whenever
  // the caller states one keeps the request self-describing either way.
  deleteCredential: (service: string, opts?: { scope?: "user" | "org" }) =>
    request<DeleteCredentialResponse>(
      "DELETE",
      `/credentials/${encodeURIComponent(service)}${opts?.scope ? `?scope=${opts.scope}` : ""}`,
    ),

  // skills — the markdown playbooks the agent reads. The catalog mixes the
  // plugin-supplied ones with the stored ones the caller owns. Only a
  // `local` skill is writable: a `repo` skill mirrors a file in the
  // repository it was synced from, and the next sync would overwrite an
  // edit made here. A stored skill is addressed by row id because a
  // shadowed skill shares its name with the skill that shadows it.
  listSkills: (opts?: SkillListQuery) => {
    const qs = new URLSearchParams();
    if (opts?.ownerType) qs.set("ownerType", opts.ownerType);
    if (opts?.ownerId) qs.set("ownerId", opts.ownerId);
    if (opts?.scope) qs.set("scope", opts.scope);
    if (opts?.kind) qs.set("kind", opts.kind);
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListSkillsResponse>("GET", `/skills${tail}`);
  },
  getSkill: (name: string) =>
    request<GetSkillResponse>("GET", `/skills/${encodeURIComponent(name)}`),
  getStoredSkill: (id: string) =>
    request<SkillResponse>("GET", `/skills/stored/${encodeURIComponent(id)}`),
  createSkill: (body: CreateSkillRequest) => request<SkillResponse>("POST", "/skills", body),
  updateSkill: (id: string, body: UpdateSkillRequest) =>
    request<SkillResponse>("PATCH", `/skills/stored/${encodeURIComponent(id)}`, body),
  deleteSkill: (id: string) =>
    request<DeleteSkillResponse>("DELETE", `/skills/stored/${encodeURIComponent(id)}`),

  // skill sources — public GitHub repositories Valet mirrors skills from.
  // Adding one imports it right away, so the create call returns what the
  // first sync did.
  listSkillSources: (opts?: SkillSourceListQuery) => {
    const qs = new URLSearchParams();
    if (opts?.ownerType) qs.set("ownerType", opts.ownerType);
    if (opts?.ownerId) qs.set("ownerId", opts.ownerId);
    if (opts?.excludeOrg) qs.set("excludeOrg", "1");
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListSkillSourcesResponse>("GET", `/skills/sources${tail}`);
  },
  createSkillSource: (body: CreateSkillSourceRequest) =>
    request<SkillSourceSyncResponse>("POST", "/skills/sources", body),
  syncSkillSource: (id: string) =>
    request<SkillSourceSyncResponse>("POST", `/skills/sources/${encodeURIComponent(id)}/sync`),
  deleteSkillSource: (id: string) =>
    request<DeleteSkillSourceResponse>("DELETE", `/skills/sources/${encodeURIComponent(id)}`),

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
  // The second setup path: connect an App that already exists. The reply is
  // the same state `getGithubApp` returns, so nothing sent here comes back.
  postGithubAppCredential: (body: PostGithubAppCredentialRequest) =>
    request<GetGithubAppResponse>("POST", "/org/github-app/credential", body),
  refreshGithubApp: () => request<GetGithubAppResponse>("POST", "/org/github-app/refresh"),
  deleteGithubApp: () => request<undefined>("DELETE", "/org/github-app"),

  // org Slack app setup — admin-gated. `name` renames the app in the
  // generated manifest, for a deployment that runs beside another Valet in
  // the same workspace.
  getSlackApp: (name?: string) =>
    request<GetSlackAppResponse>(
      "GET",
      `/org/slack${name ? `?name=${encodeURIComponent(name)}` : ""}`,
    ),

  // per-user GitHub App-OAuth connection (GitHub/repo integration plan, Task 6)
  connectGithub: () => request<PostGithubConnectResponse>("POST", "/me/github/connect"),
  disconnectGithub: () => request<undefined>("DELETE", "/me/github"),
  // The org App's state, readable by a member — `getGithubApp` above is the
  // admin-only detail read, so connect surfaces use this instead.
  getGithubOrgStatus: () => request<GetGithubOrgStatusResponse>("GET", "/me/github/org-status"),

  // identity links (channel-link Phase 7): per-user Telegram account linking
  listIdentityLinks: () => request<ListIdentityLinksResponse>("GET", "/me/identity-links"),
  startIdentityLink: (provider: string) =>
    request<StartIdentityLinkResponse>(
      "POST",
      `/me/identity-links/${encodeURIComponent(provider)}/start`,
    ),
  // 200 = DM sent; 202 = the caller's email names nobody in the workspace.
  // With body.externalId, DMs that member instead (find-me-by-name).
  deliverIdentityLink: (provider: string, body?: DeliverIdentityLinkRequest) =>
    request<DeliverIdentityLinkResponse | DeliverIdentityLinkFallback>(
      "POST",
      `/me/identity-links/${encodeURIComponent(provider)}/deliver`,
      body,
    ),
  searchLinkMembers: (provider: string, query: string) =>
    request<ListLinkMembersResponse>(
      "GET",
      `/me/identity-links/${encodeURIComponent(provider)}/members?query=${encodeURIComponent(query)}`,
    ),
  patchIdentityLink: (provider: string, body: PatchIdentityLinkRequest) =>
    request<{ ok: true }>("PATCH", `/me/identity-links/${encodeURIComponent(provider)}`, body),
  deleteIdentityLink: (provider: string) =>
    request<{ ok: true }>("DELETE", `/me/identity-links/${encodeURIComponent(provider)}`),

  // org action policies (action-policies plan, Task 4/5): admin CRUD +
  // preview, keyset-paginated action log.
  listOrgPolicies: () => request<ListOrgPoliciesResponse>("GET", "/org/policies"),
  createOrgPolicy: (body: CreateOrgPolicyRequest) =>
    request<CreateOrgPolicyResponse>("POST", "/org/policies", body),
  patchOrgPolicy: (id: string, body: PatchOrgPolicyRequest) =>
    request<PatchOrgPolicyResponse>("PATCH", `/org/policies/${encodeURIComponent(id)}`, body),
  deleteOrgPolicy: (id: string) =>
    request<DeleteOrgPolicyResponse>("DELETE", `/org/policies/${encodeURIComponent(id)}`),
  previewOrgPolicy: (body: PreviewOrgPolicyRequest) =>
    request<PreviewOrgPolicyResponse>("POST", "/org/policies/preview", body),
  listActionLog: (opts?: {
    cursor?: string;
    limit?: number;
    service?: string;
    userId?: string;
    resolvedMode?: string;
    status?: string;
    from?: number;
    to?: number;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.service) qs.set("service", opts.service);
    if (opts?.userId) qs.set("userId", opts.userId);
    if (opts?.resolvedMode) qs.set("resolvedMode", opts.resolvedMode);
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.from !== undefined) qs.set("from", String(opts.from));
    if (opts?.to !== undefined) qs.set("to", String(opts.to));
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListActionLogResponse>("GET", `/org/action-log${tail}`);
  },

  // per-user policy overrides + runtime grants (action-policies plan, Task 4/5)
  listMyPolicyOverrides: () => request<ListPolicyOverridesResponse>("GET", "/me/policy-overrides"),
  putMyPolicyOverride: (body: PutPolicyOverrideRequest) =>
    request<PutPolicyOverrideResponse>("PUT", "/me/policy-overrides", body),
  deleteMyPolicyOverride: (body: DeletePolicyOverrideRequest) =>
    request<DeletePolicyOverrideResponse>("DELETE", "/me/policy-overrides", body),
  listMyGrants: () => request<ListGrantsResponse>("GET", "/me/grants"),
  deleteMyGrant: (body: DeleteGrantRequest) =>
    request<DeleteGrantResponse>("DELETE", "/me/grants", body),

  // ── LLM proxy usage (recording-gateway dashboard) ──────────────────────
  proxyUsageSummary: (window: string = "7d") =>
    request<ProxyUsageSummary>("GET", `/proxy/usage/summary?window=${encodeURIComponent(window)}`),
  proxyRequests: (opts: {
    user?: string;
    model?: string;
    harness?: string;
    from?: number;
    to?: number;
    cursor?: string;
    limit?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (opts.user) qs.set("user", opts.user);
    if (opts.model) qs.set("model", opts.model);
    if (opts.harness) qs.set("harness", opts.harness);
    if (opts.from !== undefined) qs.set("from", String(opts.from));
    if (opts.to !== undefined) qs.set("to", String(opts.to));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const tail = qs.toString() ? `?${qs}` : "";
    return request<{ requests: ProxyRequestListItem[]; nextCursor?: string }>("GET", `/proxy/requests${tail}`);
  },
  proxyRequestDetail: (id: string) =>
    request<ProxyRequestDetail>("GET", `/proxy/requests/${encodeURIComponent(id)}`),
  proxySettings: () =>
    request<ProxySettingsResponse>("GET", "/proxy/settings"),
  setProxyMode: (mode: "centralized" | "passthrough") =>
    request<ProxySettingsResponse>("PUT", "/proxy/settings", { mode }),
  updateProxySettings: (patch: { enabled?: boolean; mode?: "centralized" | "passthrough" }) =>
    request<ProxySettingsResponse>("PUT", "/proxy/settings", patch),
};

export { ApiError };
