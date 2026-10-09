/**
 * `InstanceClient` — the CLI's typed HTTP client for a single valet instance.
 *
 * Spec decision 1: the CLI talks to an instance ONLY through the public
 * HTTP/WS API. There is no in-process engine access here — everything goes
 * over `fetch` against the same REST surface the web client uses, so the wire
 * request/response shapes are imported verbatim from `../wire/types.js`.
 *
 * Auth model (verified against `packages/api/src/app.ts` + routes):
 *   - Real instances authenticate every request with a `x-api-key: <apiKey>`
 *     header (key prefix `vlt_`), including the WS upgrade (see `stream.ts`).
 *   - Local stub instances (`VALET_LOCAL_AUTH=1`) need no credential — when
 *     `apiKey` is undefined the header is simply omitted.
 */
import { ApiError, AuthError, UnreachableError } from "./exit.js";
import { latestCredential } from "./token-refresh.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  EnsureWorkspaceRuntimeResponse,
  GetSessionResponse,
  HealthResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  GetMeResponse,
  PostSessionFileUploadResponse,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
  ActionDescribeResponse,
  ActionInvokeRequest,
  ActionInvokeResponse,
  ActionSearchResponse,
  GetSkillResponse,
  GetWorkflowRunResponse,
  ListArtifactsResponse,
  ListNotificationDecisionsResponse,
  ListSkillsResponse,
  ListTeamsResponse,
  ListWorkflowActionRequiredResponse,
  ListWorkflowsResponse,
  RetryWorkflowRunResponse,
  ShareArtifactRequest,
  ShareArtifactResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";
import * as fs from "fs";
import * as path from "path";

export interface InstanceClientOpts {
  url: string;
  apiKey?: string;
}

/** Query params accepted by `GET /api/sessions/:id/messages`. */
export interface ListMessagesOpts {
  threadId?: string;
  cursor?: string;
  limit?: number;
}

/** `GET /api/threads/:id`. `activeItemId` is the running or decision-blocked turn, when one exists. */
export interface ThreadDetail {
  id: string;
  sessionId: string;
  title: string | null;
  createdAt: number;
  archivedAt: number | null;
  activeItemId?: string;
}

/** `GET /api/memory/search`. */
export interface MemorySearchResponse {
  results: Array<{ path: string; title?: string; description?: string; snippet?: Array<{ text: string; match: boolean }> }>;
}

/** `GET /api/memory`: a file, or a directory's rendered index. */
export interface MemoryReadResponse {
  kind?: string;
  path?: string;
  rendered?: string;
  file?: { path?: string; title?: string; description?: string; tags?: string[]; content?: string; updatedAt?: number };
}

/** `PUT /api/memory` and `POST /api/memory/patch`. */
export interface MemoryWriteResponse {
  file?: { path?: string; version?: number };
}

/**
 * Owner query parameters for the memory, skills, workflow, and artifact
 * routes, which take `ownerType`/`ownerId` instead of `workspace`. A personal
 * workspace sends none, matching the MCP tools.
 */
function ownerParams(workspace: string | undefined, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams(extra);
  if (workspace && workspace !== "user") {
    params.set("ownerType", "team");
    params.set("ownerId", workspace);
  }
  return params;
}

function withQuery(base: string, params: URLSearchParams): string {
  return params.size > 0 ? `${base}?${params.toString()}` : base;
}

export class InstanceClient {
  private readonly base: string;
  /** Replaced when a long command picks up a refreshed CLI token (`latestCredential`). */
  private apiKey?: string;
  /** `GET /api/me`, read once per client: a client lives for one command,
   * and the credential does not change under it. */
  private identity?: Promise<GetMeResponse>;

  constructor(opts: InstanceClientOpts) {
    // Normalize: strip a single trailing slash so `${base}${path}` is clean.
    this.base = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  /** Base URL this client targets, trailing slash stripped. */
  get baseUrl(): string {
    return this.base;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      // A FormData body sets its own multipart content-type (with boundary);
      // only JSON bodies get one here.
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const isForm = body instanceof FormData;
    const send = async (): Promise<Response> => {
      try {
        return await fetch(url, {
          method,
          headers: this.headers(!isForm),
          body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // fetch rejects only on transport/network failure (DNS, refused, reset).
        throw new UnreachableError(`could not reach ${url}: ${(err as Error).message}`);
      }
    };
    let res = await send();
    // A CLI token this command started with may have been replaced by
    // another command's refresh. Pick up the new one and try once more.
    if (res.status === 401) {
      const fresh = await latestCredential(this.apiKey);
      if (fresh !== this.apiKey) {
        this.apiKey = fresh;
        res = await send();
      }
    }

    if (res.status === 401) {
      throw new AuthError(`authentication failed (401) for ${url}. Run \`valet login ${this.base}\` to sign in again.`);
    }
    if (!res.ok) {
      throw new ApiError(res.status, await res.text());
    }

    // 204 / empty body → nothing to parse. Guard so a caller expecting `void`
    // (or `T` it never reads) doesn't blow up on `JSON.parse("")`.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  // ── tool broker (`/api/actions`) ───────────────────────────────────────

  searchTools(opts: { query?: string; service?: string; workspace?: string; limit?: number }): Promise<ActionSearchResponse> {
    const params = new URLSearchParams();
    if (opts.query) params.set("q", opts.query);
    if (opts.service) params.set("service", opts.service);
    if (opts.workspace) params.set("workspace", opts.workspace);
    if (opts.limit) params.set("limit", String(opts.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<ActionSearchResponse>("GET", `/api/actions${suffix}`);
  }

  describeTool(toolId: string, workspace?: string, params?: Record<string, unknown>): Promise<ActionDescribeResponse> {
    const q = new URLSearchParams();
    if (workspace) q.set("workspace", workspace);
    if (params) q.set("params", JSON.stringify(params));
    const suffix = q.size > 0 ? `?${q.toString()}` : "";
    return this.request<ActionDescribeResponse>("GET", `/api/actions/${encodeURIComponent(toolId)}${suffix}`);
  }

  callTool(toolId: string, body: ActionInvokeRequest): Promise<ActionInvokeResponse> {
    return this.request<ActionInvokeResponse>("POST", `/api/actions/${encodeURIComponent(toolId)}/invoke`, body);
  }

  // ── auth / identity ────────────────────────────────────────────────────

  /** `GET /api/health` — public, no credential required. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/api/health");
  }

  /** `GET /api/me` — whoami/verify (200 ⇒ valid credential + identity).
   * A team key answers with the team (`role: "team"`), a personal key or
   * cookie with the user. */
  me(): Promise<GetMeResponse> {
    return this.request<GetMeResponse>("GET", "/api/me");
  }

  // ── orchestrator ───────────────────────────────────────────────────────

  /**
   * The caller's default assistant session, ensure-if-absent. A personal
   * credential posts `/api/workspaces/user/runtime`. A team key posts
   * `/api/workspaces/:id/runtime` for its own team, because the key acts
   * as the team and `/api/workspaces/user/runtime` would name the person who minted
   * it. Which one applies is read off `GET /api/me`.
   */
  async ensureOrchestrator(): Promise<EnsureWorkspaceRuntimeResponse> {
    this.identity ??= this.me();
    const me = await this.identity;
    const path =
      me.role === "team" ? `/api/workspaces/${encodeURIComponent(me.id)}/runtime` : "/api/workspaces/user/runtime";
    return this.request<EnsureWorkspaceRuntimeResponse>("POST", path);
  }

  // ── sessions ───────────────────────────────────────────────────────────

  listSessions(): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>("GET", "/api/sessions");
  }

  getSession(id: string): Promise<GetSessionResponse> {
    return this.request<GetSessionResponse>("GET", `/api/sessions/${encodeURIComponent(id)}`);
  }

  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>("POST", "/api/sessions", body);
  }

  // ── messages ───────────────────────────────────────────────────────────

  listMessages(id: string, opts?: ListMessagesOpts): Promise<ListMessagesResponse> {
    const qs = new URLSearchParams();
    if (opts?.threadId) qs.set("threadId", opts.threadId);
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    return this.request<ListMessagesResponse>(
      "GET",
      `/api/sessions/${encodeURIComponent(id)}/messages${suffix}`,
    );
  }

  /** `POST /api/sessions/:id/messages` — enqueue a prompt (server answers 202). */
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse> {
    return this.request<SendPromptResponse>(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/messages`,
      body,
    );
  }

  // ── threads ────────────────────────────────────────────────────────────

  getThread(id: string): Promise<ThreadDetail> {
    return this.request("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  /** `POST /api/threads/:id/abort`. The route stops only the named turn. */
  async abortThread(id: string, targetItemId: string): Promise<void> {
    await this.request("POST", `/api/threads/${encodeURIComponent(id)}/abort`, { targetItemId });
  }

  listWorkspaceThreads(workspace?: string): Promise<ListThreadsResponse> {
    return this.request("GET", `/api/threads${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`);
  }

  createWorkspaceThread(body: CreateThreadRequest, workspace?: string): Promise<CreateThreadResponse> {
    return this.request("POST", `/api/threads${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`, body);
  }


  listThreads(id: string): Promise<ListThreadsResponse> {
    return this.request<ListThreadsResponse>(
      "GET",
      `/api/sessions/${encodeURIComponent(id)}/threads`,
    );
  }

  listThreadDecisions(id: string): Promise<ListDecisionsResponse> {
    return this.request("GET", `/api/threads/${encodeURIComponent(id)}/decisions`);
  }

  resolveThreadDecision(id: string, gateId: string, body: ResolveDecisionRequest): Promise<void> {
    return this.request("POST", `/api/threads/${encodeURIComponent(id)}/decisions/${encodeURIComponent(gateId)}/resolve`, body);
  }

  // ── decision gates ─────────────────────────────────────────────────────

  listDecisions(id: string): Promise<ListDecisionsResponse> {
    return this.request<ListDecisionsResponse>(
      "GET",
      `/api/sessions/${encodeURIComponent(id)}/decisions`,
    );
  }

  /**
   * `POST /api/sessions/:id/decisions/:gateId/resolve`. The route answers
   * `{ ok: true }`; we discard it — a resolve either succeeds (200) or throws
   * (`ApiError`/`AuthError`), so `void` is the useful signal for callers.
   */
  async resolveDecision(
    id: string,
    gateId: string,
    body: ResolveDecisionRequest,
  ): Promise<void> {
    await this.request<{ ok: true }>(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/decisions/${encodeURIComponent(gateId)}/resolve`,
      body,
    );
  }

  // ── teams ──────────────────────────────────────────────────────────────

  listTeams(): Promise<ListTeamsResponse> {
    return this.request("GET", "/api/teams");
  }

  // ── memory (`/api/memory`) ─────────────────────────────────────────────

  searchMemory(query: string, workspace?: string, limit?: number): Promise<MemorySearchResponse> {
    return this.request("GET", withQuery("/api/memory/search", ownerParams(workspace, { q: query, ...(limit ? { limit: String(limit) } : {}) })));
  }

  readMemory(memoryPath: string, workspace?: string): Promise<MemoryReadResponse> {
    return this.request("GET", withQuery("/api/memory", ownerParams(workspace, { path: memoryPath })));
  }

  writeMemory(body: { path: string; content: string; description?: string; tags?: string[] }, workspace?: string): Promise<MemoryWriteResponse> {
    return this.request("PUT", withQuery("/api/memory", ownerParams(workspace)), body);
  }

  patchMemory(body: { path: string; oldString: string; newString: string }, workspace?: string): Promise<MemoryWriteResponse> {
    return this.request("POST", withQuery("/api/memory/patch", ownerParams(workspace)), body);
  }

  async moveMemory(from: string, to: string, workspace?: string): Promise<void> {
    await this.request("POST", withQuery("/api/memory/move", ownerParams(workspace)), { from, to });
  }

  async deleteMemory(memoryPath: string, workspace?: string): Promise<void> {
    await this.request("DELETE", withQuery("/api/memory", ownerParams(workspace, { path: memoryPath })));
  }

  // ── skills (`/api/skills`) ─────────────────────────────────────────────

  listSkills(opts: { query?: string; workspace?: string; limit?: number }): Promise<ListSkillsResponse> {
    return this.request("GET", withQuery("/api/skills", ownerParams(opts.workspace, {
      ...(opts.query ? { q: opts.query } : {}), limit: String(opts.limit ?? 50),
    })));
  }

  getSkill(name: string): Promise<GetSkillResponse> {
    return this.request("GET", `/api/skills/${encodeURIComponent(name)}`);
  }

  // ── workflows (`/api/workflows`) ───────────────────────────────────────

  listWorkflows(workspace?: string): Promise<ListWorkflowsResponse> {
    return this.request("GET", withQuery("/api/workflows", ownerParams(workspace)));
  }

  startWorkflowRun(workflowId: string, input?: Record<string, unknown>): Promise<StartWorkflowRunResponse> {
    return this.request("POST", `/api/workflows/${encodeURIComponent(workflowId)}/runs`, input ? { input } : {});
  }

  getWorkflowRun(runId: string): Promise<GetWorkflowRunResponse> {
    return this.request("GET", `/api/workflows/runs/${encodeURIComponent(runId)}`);
  }

  async cancelWorkflowRun(runId: string): Promise<void> {
    await this.request("POST", `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`);
  }

  retryWorkflowRun(runId: string): Promise<RetryWorkflowRunResponse> {
    return this.request("POST", `/api/workflows/runs/${encodeURIComponent(runId)}/retry`);
  }

  listWorkflowActionRequired(): Promise<ListWorkflowActionRequiredResponse> {
    return this.request("GET", "/api/workflows/action-required");
  }

  // ── artifacts (`/api/artifacts`) and the inbox ─────────────────────────

  listArtifacts(workspace?: string): Promise<ListArtifactsResponse> {
    return this.request("GET", withQuery("/api/artifacts", ownerParams(workspace)));
  }

  shareArtifact(body: ShareArtifactRequest, workspace?: string): Promise<ShareArtifactResponse> {
    return this.request("POST", withQuery("/api/artifacts/share", ownerParams(workspace)), body);
  }

  async revokeArtifact(id: string): Promise<void> {
    await this.request("DELETE", `/api/artifacts/${encodeURIComponent(id)}`);
  }

  listInboxDecisions(): Promise<ListNotificationDecisionsResponse> {
    return this.request("GET", "/api/notifications/decisions");
  }

  // ── file uploads ───────────────────────────────────────────────────────

  /**
   * `POST /api/sessions/:id/files` — upload files to a session's sandbox.
   * Accepts one file per request via multipart/form-data. Returns uploaded
   * file metadata including the attachment ref.
   */
  async uploadFile(
    sessionId: string,
    sourcePath: string,
    dest?: string,
    extract?: "auto" | "true" | "false",
    overwrite?: boolean,
  ): Promise<PostSessionFileUploadResponse> {
    const file = await fs.promises.readFile(sourcePath);
    const filename = path.basename(sourcePath);

    // Build the multipart body; request() ships FormData as-is.
    const form = new FormData();
    const blob = new Blob([file], { type: "application/octet-stream" });
    form.append("file", blob, filename);

    if (dest !== undefined) {
      form.append("dest", dest);
    }
    if (extract !== undefined) {
      form.append("extract", extract);
    }
    if (overwrite) {
      form.append("overwrite", "true");
    }

    return this.request<PostSessionFileUploadResponse>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/files`,
      form,
    );
  }
}
