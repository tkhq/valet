/**
 * Typed REST client. Routes are documented inline; types come from
 * `@valet/api/wire` so server + web agree on the shape.
 *
 * Auth: in dev mode, the server runs with VALET_LOCAL_AUTH=1 and accepts any
 * (or no) Authorization header. We don't ship one for now; later when real
 * auth lands we'll wire token storage here.
 */
import type {
  CancelWorkflowRunResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  DeleteCredentialResponse,
  EnsureOrchestratorResponse,
  GetMemoryTreeResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  GetSessionResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListCredentialsResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListPluginsResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  MeResponse,
  PatchOrchestratorInfoRequest,
  PatchOrchestratorInfoResponse,
  PatchSessionRequest,
  PatchSessionResponse,
  PatchThreadRequest,
  PatchThreadResponse,
  PutCredentialRequest,
  PutCredentialResponse,
  ResolveDecisionRequest,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  SendPromptRequest,
  SendPromptResponse,
  SetNotificationPreferenceRequest,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  WithdrawDecisionRequest,
} from "@valet/api/wire";
import type { GetMemoryDocResponse, SearchMemoryResponse } from "./memory-types";

const BASE = "/api"; // Vite proxies /api → server; same in production.

class ApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
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
    throw new ApiError(res.status, `${method} ${path} → ${res.status}`, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // auth
  me: () => request<MeResponse>("GET", "/auth/me"),

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
  startWorkflowRun: (id: string, body: StartWorkflowRunRequest = {}) =>
    request<StartWorkflowRunResponse>(
      "POST",
      `/workflows/${encodeURIComponent(id)}/runs`,
      body,
    ),
  listWorkflowRuns: (id: string) =>
    request<ListWorkflowRunsResponse>("GET", `/workflows/${encodeURIComponent(id)}/runs`),
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
};

export { ApiError };
