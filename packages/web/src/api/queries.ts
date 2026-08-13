/**
 * TanStack Query hooks for the REST surface. Live updates from the WS stream
 * are handled separately (see `src/stores/stream.ts`); these hooks own the
 * historical-state side of the picture (initial fetch + cache-invalidation
 * on mutations).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  GetSessionResponse,
  ListDecisionsResponse,
  ListIdentityLinksResponse,
  ListMessagesResponse,
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  PatchIdentityLinkRequest,
  PatchSessionResponse,
  PatchThreadResponse,
  PauseSessionResponse,
  ResolveDecisionRequest,
  SandboxJwtResponse,
  SessionRunState,
  SetNotificationPreferenceRequest,
  StartIdentityLinkResponse,
} from "@valet/api/wire";
import { useLiveQuery } from "~/lib/use-live-query";
import { api } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qk = {
  sessions: () => ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  threads: (id: string) => ["sessions", id, "threads"] as const,
  messages: (id: string, threadId?: string) =>
    threadId
      ? (["sessions", id, "messages", threadId] as const)
      : (["sessions", id, "messages"] as const),
  decisions: (id: string) => ["sessions", id, "decisions"] as const,
  notifications: () => ["notifications"] as const,
  notificationPreferences: () => ["notifications", "preferences"] as const,
  identityLinks: () => ["identityLinks"] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * The run states that keep the sessions list polling.
 *
 * `working` changes on its own — that is the whole reason the page is open.
 * `needs_you` changes when a person answers the gate, and the person can
 * answer from a chat channel or a second tab, so this page has to follow
 * that too. The rest are quiet: `failed`, `sleeping` and `idle` only move
 * when someone sends new work, and every path that sends work already
 * invalidates this query.
 */
const LIVE_SESSION_STATES: ReadonlySet<SessionRunState> = new Set<SessionRunState>([
  "working",
  "needs_you",
]);

/** The "is anything moving?" rule for the sessions list. Exported because
 * the poll cost of the page depends on it, so it gets its own test. */
export function sessionsAreLive(data: ListSessionsResponse): boolean {
  return data.sessions.some((s) => LIVE_SESSION_STATES.has(s.runState));
}

/**
 * Polls while any session is working or blocked on a person, and stops when
 * none are. See `lib/use-live-query.ts` for the policy.
 */
export function useSessions(opts?: UseQueryOptions<ListSessionsResponse>) {
  return useLiveQuery<ListSessionsResponse>({
    queryKey: qk.sessions(),
    queryFn: () => api.listSessions(),
    isLive: sessionsAreLive,
    ...opts,
  });
}

export function useSession(id: string, opts?: UseQueryOptions<GetSessionResponse>) {
  return useQuery<GetSessionResponse>({
    queryKey: qk.session(id),
    queryFn: () => api.getSession(id),
    enabled: !!id,
    ...opts,
  });
}

export function useThreads(id: string, opts?: UseQueryOptions<ListThreadsResponse>) {
  return useQuery<ListThreadsResponse>({
    queryKey: qk.threads(id),
    queryFn: () => api.listThreads(id),
    enabled: !!id,
    ...opts,
  });
}

export function useMessages(
  id: string,
  threadId?: string,
  opts?: UseQueryOptions<ListMessagesResponse>,
) {
  return useQuery<ListMessagesResponse>({
    queryKey: qk.messages(id, threadId),
    queryFn: () => api.listMessages(id, { limit: 200, threadId }),
    enabled: !!id,
    // Background refetches (window focus, network reconnect) would call
    // setThreadMessages and risk wiping in-flight optimistic / live state.
    // Initial load + thread-switch refetches still happen because each
    // (sessionId, threadId) pair is its own queryKey.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    ...opts,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation<CreateSessionResponse, Error, CreateSessionRequest>({
    mutationFn: (body) => api.createSession(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/** POST /:id/pause (sandbox hibernation plan, Task 5) — the sandbox's
 * terminal state transition arrives over the `sandbox.status` stream, but
 * the session row's `status` field only updates via this response, so the
 * session detail query still needs an explicit invalidation. */
export function usePauseSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PauseSessionResponse, Error, void>({
    mutationFn: () => api.pauseSession(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useCreateThread(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<CreateThreadResponse, Error, CreateThreadRequest | void>({
    mutationFn: (body) => api.createThread(sessionId, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.threads(sessionId) });
    },
  });
}

export function useSetSessionModel(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchSessionResponse, Error, string>({
    mutationFn: (model) => api.patchSession(sessionId, { model }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useSetThreadModel(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    PatchThreadResponse,
    Error,
    { threadId: string; model: string | null }
  >({
    mutationFn: ({ threadId, model }) =>
      api.patchThread(sessionId, threadId, { model }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.threads(sessionId) });
    },
  });
}

export function useDecisions(
  sessionId: string,
  opts?: UseQueryOptions<ListDecisionsResponse>,
) {
  return useQuery<ListDecisionsResponse>({
    queryKey: qk.decisions(sessionId),
    queryFn: () => api.listDecisions(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

export function useResolveDecision(sessionId: string) {
  return useMutation<
    { ok: true },
    Error,
    { gateId: string; body: ResolveDecisionRequest }
  >({
    mutationFn: ({ gateId, body }) => api.resolveDecision(sessionId, gateId, body),
    // The bus → wire path emits decision_gate_resolved which the stream
    // store consumes; no query invalidation needed.
  });
}

export function useWithdrawDecision(sessionId: string) {
  return useMutation<{ ok: true }, Error, { gateId: string }>({
    mutationFn: ({ gateId }) =>
      api.withdrawDecision(sessionId, gateId, { reason: "cancel" }),
  });
}

// ── Notifications (attention router, Phase 4 decision 19/22) ─────────────
//
// 30s polling, no WS plumbing this phase — see the design doc's "Web
// surface (minimal)" note.

export function useNotifications(opts?: UseQueryOptions<ListNotificationsResponse>) {
  return useQuery<ListNotificationsResponse>({
    queryKey: qk.notifications(),
    queryFn: () => api.listNotifications(),
    refetchInterval: 30_000,
    ...opts,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.markNotificationRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.notifications() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.notifications() });
    },
  });
}

export function useSendPrompt(sessionId: string) {
  return useMutation<
    { messageId: string; threadId: string },
    Error,
    { text: string; threadId?: string }
  >({
    mutationFn: ({ text, threadId }) =>
      api.sendPrompt(sessionId, { text, threadId }),
    // Invalidations not needed — live updates flow through the WS store.
  });
}

/**
 * Mints a short-lived sandbox gateway JWT for the "full"-profile session's
 * ttyd/code-server iframe (sandbox auth gateway plan, Task 7). No
 * invalidation — each call mints a fresh token; the sandbox-tabs component
 * re-invokes this on tab switch and on a 401-driven silent re-mint.
 */
export function useSandboxJwt(sessionId: string) {
  return useMutation<SandboxJwtResponse, Error, void>({
    mutationFn: () => api.mintSandboxJwt(sessionId),
  });
}

export function useAbortThread(sessionId: string) {
  return useMutation<{ ok: true }, Error, { threadId: string }>({
    mutationFn: ({ threadId }) => api.abortThread(sessionId, threadId),
    // No invalidation — the abort's terminal state (submission settled
    // `aborted`, thread status back to idle) arrives via the WS stream,
    // same as every other engine-driven state transition.
  });
}

// ── Notification preferences (web delivery, Phase 4 decision 19/22) ─────

export function useNotificationPreferences(
  opts?: UseQueryOptions<ListNotificationPreferencesResponse>,
) {
  return useQuery<ListNotificationPreferencesResponse>({
    queryKey: qk.notificationPreferences(),
    queryFn: () => api.listNotificationPreferences(),
    ...opts,
  });
}

export function useSetNotificationPreference() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, SetNotificationPreferenceRequest>({
    mutationFn: (body) => api.setNotificationPreference(body),
    // Refetch-on-success — simplest honest source of truth for a settings
    // toggle that's touched rarely; no need for optimistic update plumbing.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.notificationPreferences() });
    },
  });
}

// ── Identity links (channel-link Phase 7) — per-user Telegram linking ───

export function useIdentityLinks(opts?: UseQueryOptions<ListIdentityLinksResponse>) {
  return useQuery<ListIdentityLinksResponse>({
    queryKey: qk.identityLinks(),
    queryFn: () => api.listIdentityLinks(),
    ...opts,
  });
}

export function useStartIdentityLink() {
  const qc = useQueryClient();
  return useMutation<StartIdentityLinkResponse, Error, string>({
    mutationFn: (provider) => api.startIdentityLink(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

export function useSetLinkNotify() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, PatchIdentityLinkRequest>({
    mutationFn: (body) => api.patchIdentityLink("telegram", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

export function useUnlinkIdentity() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.deleteIdentityLink("telegram"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}
