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
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  EnsureOrchestratorResponse,
  GetSessionResponse,
  HealthResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  MeResponse,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
} from "../wire/types.js";

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

export class InstanceClient {
  private readonly base: string;
  private readonly apiKey?: string;

  constructor(opts: InstanceClientOpts) {
    // Normalize: strip a single trailing slash so `${base}${path}` is clean.
    this.base = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  /** Base URL this client targets, trailing slash stripped. */
  get baseUrl(): string {
    return this.base;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // fetch rejects only on transport/network failure (DNS, refused, reset).
      throw new UnreachableError(`could not reach ${url}: ${(err as Error).message}`);
    }

    if (res.status === 401) {
      throw new AuthError(`authentication failed (401) for ${url}`);
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

  // ── auth / identity ────────────────────────────────────────────────────

  /** `GET /api/health` — public, no credential required. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/api/health");
  }

  /** `GET /api/me` — whoami/verify (200 ⇒ valid credential + identity). */
  me(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/api/me");
  }

  // ── orchestrator ───────────────────────────────────────────────────────

  /** `POST /api/orchestrator` — ensure-if-absent, returns the session id. */
  ensureOrchestrator(): Promise<EnsureOrchestratorResponse> {
    return this.request<EnsureOrchestratorResponse>("POST", "/api/orchestrator");
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

  listThreads(id: string): Promise<ListThreadsResponse> {
    return this.request<ListThreadsResponse>(
      "GET",
      `/api/sessions/${encodeURIComponent(id)}/threads`,
    );
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
}
