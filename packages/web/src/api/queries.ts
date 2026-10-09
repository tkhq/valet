/**
 * TanStack Query hooks for the REST surface. Live updates from the WS stream
 * are handled separately (see `src/stores/stream.ts`); these hooks own the
 * historical-state side of the picture (initial fetch + cache-invalidation
 * on mutations).
 */
import { threadOriginBucket } from "~/lib/thread-origin";
import { isAppAssistantThread } from "~/lib/thread-default";
import {
  useInfiniteQuery,
  isCancelledError,
  skipToken,
  type InfiniteData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  DeliverIdentityLinkFallback,
  DeliverIdentityLinkRequest,
  DeliverIdentityLinkResponse,
  VerifyIdentityLinkResponse,
  GetSessionResponse,
  ListDecisionsResponse,
  ListIdentityLinksResponse,
  ListLinkMembersResponse,
  ListMessagesResponse,
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListThreadsResponse,
  ThreadSummary,
  PatchIdentityLinkRequest,
  PatchSessionResponse,
  PatchThreadResponse,
  PauseSessionResponse,
  ListSessionWakeupsResponse,
  CancelSessionWakeupResponse,
  PutRatingResponse,
  RatingValue,
  ResolveDecisionRequest,
  SandboxJwtResponse,
  SandboxProfile,
  SetNotificationPreferenceRequest,
  StartIdentityLinkResponse,
} from "@valet/api/wire";
import { api, type OwnerFilter } from "./client";

// ── Query key factory ────────────────────────────────────────────────────

export const qk = {
  /** The owner is a trailing element, so `["sessions"]` stays the prefix
   * that invalidates every workspace's list at once. */
  sessions: (owner?: OwnerFilter) =>
    ["sessions", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  session: (id: string) => ["sessions", id] as const,
  threads: (id: string) => ["sessions", id, "threads"] as const,
  threadPages: (id: string, options?: object) => ["sessions", id, "threads", "pages", ...(options ? [options] : [])] as const,
  threadSearch: (id: string, query: string) => ["sessions", id, "threads", "search", query] as const,
  threadsArchived: (id: string) => ["sessions", id, "threads", "archived"] as const,
  messages: (id: string, threadId?: string) =>
    threadId
      ? (["sessions", id, "messages", threadId] as const)
      : (["sessions", id, "messages"] as const),
  decisions: (id: string) => ["sessions", id, "decisions"] as const,
  ratings: (id: string) => ["sessions", id, "ratings"] as const,
  wakeups: (id: string) => ["sessions", id, "wakeups"] as const,
  notifications: () => ["notifications"] as const,
  notificationPreferences: () => ["notifications", "preferences"] as const,
  identityLinks: () => ["identityLinks"] as const,
  linkMembers: (provider: string, query: string) => ["linkMembers", provider, query] as const,
};

/** Execution updates also refresh workspace aggregates containing that execution. */
export function threadListFilters(sessionId: string) {
  return { predicate: ({ queryKey, state }: Query) => {
    if (queryKey[0] !== "sessions" || queryKey[2] !== "threads") return false;
    if (queryKey[1] === sessionId) return true;
    const data = state.data;
    if (data && typeof data === "object" && "pages" in data && Array.isArray(data.pages)) {
      return data.pages.some(page => page && typeof page === "object" && "threads" in page && Array.isArray(page.threads)
        && page.threads.some((thread: unknown) => thread && typeof thread === "object" && "sessionId" in thread && thread.sessionId === sessionId));
    }
    return Boolean(data && typeof data === "object" && "threads" in data && Array.isArray(data.threads)
      && data.threads.some(thread => thread && typeof thread === "object" && "sessionId" in thread && thread.sessionId === sessionId));
  } };
}

// ── Reads ────────────────────────────────────────────────────────────────

export function useSession(id: string, opts?: Partial<UseQueryOptions<GetSessionResponse>>) {
  return useQuery<GetSessionResponse>({
    queryKey: qk.session(id),
    queryFn: () => api.getSession(id),
    enabled: !!id,
    ...opts,
  });
}

export function useThreads(id: string, opts?: UseQueryOptions<ListThreadsResponse>, selectedThreadId?: string) {
  return useQuery<ListThreadsResponse>({
    queryKey: selectedThreadId ? [...qk.threads(id), "selected", selectedThreadId] : qk.threads(id),
    queryFn: () => api.listThreads(id, { threadId: selectedThreadId, limit: 10 }),
    enabled: !!id,
    ...opts,
  });
}

/** Keep each fixed-row request below common proxy URL limits, including encoded IDs. */
export function fixedThreadBatches(ids: string[]): string[][] {
  const batches: string[][] = [];
  let bytes = 0;
  for (const id of [...new Set(ids)].sort()) {
    const size = encodeURIComponent(id).length + 9;
    if (size > 2048) throw new Error("A saved thread ID is too long. Remove the invalid pin or project assignment.");
    if (!batches.length || batches[batches.length - 1].length >= 50 || bytes + size > 3000) {
      batches.push([]);
      bytes = 0;
    }
    batches[batches.length - 1].push(id);
    bytes += size;
  }
  return batches;
}

async function readFixedThreads(id: string, fixedIds: string[], threadId?: string): Promise<ListThreadsResponse> {
  const batches = fixedThreadBatches(fixedIds);
  if (!batches.length && threadId) batches.push([]);
  const threads: ThreadSummary[] = [];
  // Serial batches bound concurrent workspace metadata reads for large projects.
  for (const fixedIds of batches) {
    const page = await api.listThreads(id, { fixedIds, fixedOnly: true, threadId });
    threads.push(...page.threads);
  }
  return { threads: [...new Map(threads.map(thread => [thread.id, thread])).values()] };
}

export function useSidebarThreads(id: string, options: { sort: string; origin: string; fixedIds: string[]; threadId?: string }) {
  const { sort, origin, threadId } = options;
  const fixedIds = [...new Set(options.fixedIds)].sort();
  const query = useInfiniteQuery({
    queryKey: qk.threadPages(id, { sort, origin }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listThreads(id, { sort, origin, limit: 10, cursor: pageParam }),
    getNextPageParam: page => page.nextCursor,
    enabled: !!id,
  });
  const fixed = useQuery({
    queryKey: [...qk.threads(id), "fixed", fixedIds, threadId],
    queryFn: () => readFixedThreads(id, fixedIds, threadId),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === id ? previous : undefined,
    enabled: !!id && (fixedIds.length > 0 || !!threadId),
  });
  const pages = query.data?.pages;
  return { ...query, fixedReady: !fixed.isFetching && !fixed.isError,
    fixedError: fixed.error, refetchFixed: fixed.refetch,
    data: pages ? {
      ...pages[0], threads: [...new Map([...pages.flatMap(page => page.threads), ...(fixed.data?.threads.filter(thread => fixedIds.includes(thread.id) || thread.id === threadId) ?? [])].map(thread => [thread.id, thread])).values()],
    } : undefined };
}

export function mapThreadData(current: ListThreadsResponse | InfiniteData<ListThreadsResponse> | undefined, change: (thread: ThreadSummary) => ThreadSummary) {
  if (!current) return current;
  if ("pages" in current) return { ...current, pages: current.pages.map(page => ({ ...page, threads: page.threads.map(change) })) };
  return { ...current, threads: current.threads.map(change) };
}

export function useThreadSearch(id: string, query: string, enabled: boolean, fixedIds: string[] = []) {
  return useQuery<ListThreadsResponse>({
    queryKey: [...qk.threadSearch(id, query), fixedIds],
    queryFn: async () => {
      const matches = await api.listThreads(id, { q: query });
      const fixed = await readFixedThreads(id, fixedIds);
      return { ...matches, threads: [...new Map([...matches.threads, ...fixed.threads].map(thread => [thread.id, thread])).values()] };
    },
    enabled: enabled && !!id && !!query,
    staleTime: 0,
  });
}

/** Archived threads (`GET /threads?archived=1`) — display state only; an
 * archived thread's history is intact and unarchive restores it to the
 * default list. */
export function useArchivedThreads(id: string, opts?: Partial<UseQueryOptions<ListThreadsResponse>>) {
  return useQuery<ListThreadsResponse>({
    queryKey: qk.threadsArchived(id),
    queryFn: () => api.listThreads(id, { archived: true }),
    enabled: !!id,
    ...opts,
  });
}

export function useMessages(
  id: string,
  threadId?: string,
  opts?: Partial<UseQueryOptions<ListMessagesResponse>>,
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

/** POST /:id/sandbox/replace — re-provision the session's sandbox in
 * place. Threads and history are untouched; the new sandbox's state
 * arrives over the `sandbox.status` stream, so no query invalidation is
 * needed beyond the session row. */
export function useReplaceSandbox(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.replaceSandbox(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    },
  });
}

/** GET /:id/wakeups: the session's open background work (wakeups and
 * leases). Nothing pushes changes over the stream, so the header badge
 * polls once a minute while it is mounted. */
export function useSessionWakeups(sessionId: string | undefined) {
  return useQuery<ListSessionWakeupsResponse>({
    queryKey: qk.wakeups(sessionId ?? ""),
    queryFn: sessionId ? () => api.listSessionWakeups(sessionId) : skipToken,
    refetchInterval: 60_000,
  });
}

/** POST /:id/wakeups/:wakeupId/cancel: a person stops one wakeup or hold.
 * Optimistic: the row leaves the list at once and comes back on error. */
export function useCancelSessionWakeup(sessionId: string) {
  const qc = useQueryClient();
  const key = qk.wakeups(sessionId);
  return useMutation<
    CancelSessionWakeupResponse,
    Error,
    string,
    { previous?: ListSessionWakeupsResponse }
  >({
    mutationFn: (wakeupId) => api.cancelSessionWakeup(sessionId, wakeupId),
    onMutate: async (wakeupId) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ListSessionWakeupsResponse>(key);
      if (previous) {
        qc.setQueryData<ListSessionWakeupsResponse>(key, {
          wakeups: previous.wakeups.filter((w) => w.id !== wakeupId),
          leases: previous.leases.filter((l) => l.id !== wakeupId && l.ownerId !== wakeupId),
        });
      }
      return { previous };
    },
    onError: (_err, _wakeupId, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useCreateThread(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<CreateThreadResponse, Error, CreateThreadRequest | void>({
    mutationFn: (body) => api.createThread(sessionId, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries(threadListFilters(sessionId));
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

/** PATCH /:id with a `reasoning` — set the session-default reasoning
 * level (`null` clears it back to the account default). Mirrors
 * `useSetSessionModel`: new threads pin it at creation, existing threads
 * track it only when they carry no reasoning pin of their own. */
export function useSetSessionReasoning(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchSessionResponse, Error, string | null>({
    mutationFn: (reasoning) => api.patchSession(sessionId, { reasoning }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/** PATCH /:id with a `title` — rename the session. The session row and the
 * session lists both render the title, so both caches are invalidated. */
/** The caller's persisted 👍/👎 state for one session (TKAI-334). */
export function useSessionRatings(sessionId: string) {
  return useQuery({
    queryKey: qk.ratings(sessionId),
    queryFn: () => api.getSessionRatings(sessionId),
  });
}


/** Message-level 👍/👎 on one assistant entry. `null` clears the rating. */
export function useRateMessage(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PutRatingResponse, Error, { entryId: string; threadId?: string; rating: RatingValue | null }>({
    mutationFn: ({ entryId, threadId, rating }) =>
      api.rateMessage(sessionId, entryId, { rating, ...(threadId !== undefined ? { threadId } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ratings(sessionId) });
    },
  });
}

export function useRenameSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchSessionResponse, Error, string>({
    mutationFn: (title) => api.patchSession(sessionId, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/** PATCH /:id with a `teamId` — move the session to a team's workspace, or
 * (`null`) to the caller's own. `["sessions"]` is a prefix of every scoped
 * list key, so one invalidation refreshes the workspace it left and the one
 * it joined. */
export function useMoveSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchSessionResponse, Error, string | null>({
    mutationFn: (teamId) => api.patchSession(sessionId, { teamId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/** PATCH /:id with a `profile` — turn the sandbox's terminal and VS Code
 * server on or off. The server replaces a running sandbox, so the session
 * row and the live `sandbox.status` both change. */
export function useSetSessionProfile(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchSessionResponse, Error, SandboxProfile>({
    mutationFn: (profile) => api.patchSession(sessionId, { profile }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/** PATCH /threads/:id with a `model` — set the thread's pin (`null` clears
 * it back to tracking the session default). Threads pin their model at
 * creation, so this is the picker every existing chat uses; the session
 * default only governs new threads. */
export function useSetThreadModel(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchThreadResponse, Error, { threadId: string; model: string | null }>({
    mutationFn: ({ threadId, model }) => api.patchThread(threadId, { model }),
    onSuccess: async (saved) => {
      // A GET started before the save must not overwrite its confirmed pin.
      await qc.cancelQueries(threadListFilters(sessionId));
      // PATCH confirms the pin. Update only that field so newer activity
      // and title updates survive a slower model save.
      qc.setQueriesData<ListThreadsResponse | InfiniteData<ListThreadsResponse>>(
        threadListFilters(sessionId),
        (current) => mapThreadData(current, thread => thread.id === saved.id ? { ...thread, model: saved.model } : thread),
      );
    },
  });
}

/** PATCH /threads/:id with a `reasoning` — set the thread's reasoning pin
 * (`null` clears it back to tracking the session default). Mirrors
 * `useSetThreadModel`. */
export function useSetThreadReasoning(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchThreadResponse, Error, { threadId: string; reasoning: string | null }>({
    mutationFn: ({ threadId, reasoning }) => api.patchThread(threadId, { reasoning }),
    onSuccess: () => {
      qc.invalidateQueries(threadListFilters(sessionId));
    },
  });
}

/** Marks threads read for the viewer; with no ids, every thread in the session.
 * The list shows them read at once; the server keeps the later timestamp. */
export function useMarkThreadsRead(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, { threadIds?: string[] }>({
    mutationFn: ({ threadIds }) => api.markThreadsRead(sessionId, threadIds),
    onMutate: ({ threadIds }) => {
      const at = Date.now();
      const ids = new Set(threadIds ?? qc.getQueriesData<ListThreadsResponse | InfiniteData<ListThreadsResponse>>({ queryKey: qk.threads(sessionId) })
        .flatMap(([, data]) => !data ? [] : "pages" in data ? data.pages.flatMap(page => page.threads) : data.threads)
        .map(thread => thread.id));
      qc.setQueriesData<ListThreadsResponse | InfiniteData<ListThreadsResponse>>(threadListFilters(sessionId), (current) => mapThreadData(current, thread =>
        (ids.has(thread.id) || (!threadIds && thread.sessionId === sessionId)) ? { ...thread, readAt: Math.max(thread.readAt ?? 0, at) } : thread));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["workspace-waiting"] });
    },
  });
}

export function useSetThreadArchived(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchThreadResponse, Error, { threadId: string; archived: boolean }>({
    mutationFn: ({ threadId, archived }) =>
      api.patchThread(threadId, { archived }),
    onSuccess: async (_saved, { threadId }) => {
      // An older supplemental activity read must not reinsert the archived row.
      await qc.cancelQueries({ predicate: query => query.queryKey[0] === "sessions"
        && query.queryKey[2] === "threads" && query.queryKey[3] === "activity" && query.queryKey[4] === threadId });
      qc.invalidateQueries(threadListFilters(sessionId));
      qc.invalidateQueries({ queryKey: qk.threadsArchived(sessionId) });
    },
  });
}

/** Rename a thread. Use `null` to clear its stored title. */
export function useRenameThread(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PatchThreadResponse, Error, { threadId: string; title: string | null }>({
    mutationFn: ({ threadId, title }) =>
      api.patchThread(threadId, { title }),
    onSuccess: () => {
      qc.invalidateQueries(threadListFilters(sessionId));
      qc.invalidateQueries({ queryKey: qk.threadsArchived(sessionId) });
    },
  });
}

export function useDecisions(
  sessionId: string,
  opts?: Omit<UseQueryOptions<ListDecisionsResponse>, "queryKey" | "queryFn">,
) {
  return useQuery<ListDecisionsResponse>({
    queryKey: qk.decisions(sessionId),
    queryFn: () => api.listDecisions(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

export function useNotificationDecisions(cursor?: string, enabled = true) {
  return useQuery({ queryKey: ["notification-decisions", cursor], queryFn: () => api.listNotificationDecisions(cursor), enabled, refetchInterval: 5000 });
}

export function useResolveDecision(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { gateId: string; body: ResolveDecisionRequest }
  >({
    mutationFn: ({ gateId, body }) => api.resolveDecision(sessionId, gateId, body),
    // Approval-only views poll this query without a session stream.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.decisions(sessionId) });
      void qc.invalidateQueries({ queryKey: ["notification-decisions"] });
    },
  });
}

export function useWithdrawDecision(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { gateId: string }>({
    mutationFn: ({ gateId }) =>
      api.withdrawDecision(sessionId, gateId, { reason: "cancel" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.decisions(sessionId) });
      void qc.invalidateQueries({ queryKey: ["notification-decisions"] });
    },
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
  const qc = useQueryClient();
  return useMutation<
    import("@valet/api/wire").SendPromptResponse,
    Error,
    import("@valet/api/wire").SendPromptRequest
  >({
    mutationFn: (body) =>
      api.sendPrompt(sessionId, body),
    // Update the sender now with the timestamp that the server persisted.
    // Socket events update other viewers; a later thread-list fetch reconciles
    // this cache with the persisted value.
    onSuccess: (data, { text }) => {
      qc.setQueriesData<ListThreadsResponse | InfiniteData<ListThreadsResponse>>(threadListFilters(sessionId), (current) => mapThreadData(current, thread => thread.id === data.threadId
        ? { ...thread, lastUserActivityAt: Math.max(thread.lastUserActivityAt, data.activityAt) } : thread));
      if (text.startsWith("/")) void qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
    },
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
  return useMutation<{ ok: true }, Error, { threadId: string; targetItemId: string }>({
    mutationFn: ({ threadId, targetItemId }) =>
      api.abortThread(threadId, { targetItemId }),
    // No invalidation — the abort's terminal state (submission settled
    // `aborted`, thread status back to idle) arrives via the WS stream,
    // same as every other engine-driven state transition.
  });
}

export function useResumeThread(sessionId: string) {
  return useMutation<{ ok: true }, Error, { threadId: string }>({
    mutationFn: ({ threadId }) => api.resumeThread(threadId),
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

export function useIdentityLinks(
  opts?: Omit<UseQueryOptions<ListIdentityLinksResponse>, "queryKey" | "queryFn">,
) {
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

export function useDeliverIdentityLink() {
  const qc = useQueryClient();
  return useMutation<
    DeliverIdentityLinkResponse | DeliverIdentityLinkFallback,
    Error,
    { provider: string; member?: DeliverIdentityLinkRequest }
  >({
    mutationFn: ({ provider, member }) => api.deliverIdentityLink(provider, member),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

/** Enters the code the bot DMed. Success links the account, so the link
 * list refetches and the card flips to "Linked". */
export function useVerifyIdentityLink() {
  const qc = useQueryClient();
  return useMutation<VerifyIdentityLinkResponse, Error, { provider: string; code: string }>({
    mutationFn: ({ provider, code }) => api.verifyIdentityLink(provider, code),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

/** Workspace-member typeahead for the find-me-by-name link fallback. */
export function useLinkMembers(provider: string, query: string, enabled: boolean) {
  return useQuery<ListLinkMembersResponse>({
    queryKey: qk.linkMembers(provider, query),
    queryFn: () => api.searchLinkMembers(provider, query),
    enabled,
    staleTime: 30_000,
  });
}

export function useSetLinkNotify(provider: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, PatchIdentityLinkRequest>({
    mutationFn: (body) => api.patchIdentityLink(provider, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

export function useUnlinkIdentity(provider: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.deleteIdentityLink(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identityLinks() });
    },
  });
}

/** Read only the promoted row; keep loaded pages and their cursor chain. */
export async function refreshMissingActivityThread(client: QueryClient, threadId: string) {
  // An execution socket may name a row absent from its root workspace cache.
  // Let each active runtime's authorized fixed-row endpoint resolve membership.
  const queries = client.getQueryCache().findAll({ type: "active", predicate: query =>
    query.queryKey[0] === "sessions" && query.queryKey[2] === "threads" && query.queryKey[3] === "pages",
  });
  await Promise.all(queries.map(async query => {
    const options = query.queryKey[4] as { sort?: string; origin?: string } | undefined;
    const data = query.state.data as InfiniteData<ListThreadsResponse> | undefined;
    if (!data || options?.sort === "created" || data.pages.some(page => page.threads.some(thread => thread.id === threadId))) return;
    const runtimeId = query.queryKey[1] as string;
    let response: ListThreadsResponse;
    try {
      response = await client.fetchQuery({
        queryKey: [...qk.threads(runtimeId), "activity", threadId],
        queryFn: () => api.listThreads(runtimeId, { fixedOnly: true, fixedIds: [threadId] }),
        staleTime: 0,
      });
    } catch (error) {
      if (!isCancelledError(error) && query.isActive()) {
        // The list owns retry/error UI; do not refresh other cached workspaces.
        await client.invalidateQueries({ queryKey: query.queryKey, exact: true });
      }
      return;
    }
    if (!query.isActive()) return;
    const rows = response.threads.filter(thread => thread.archivedAt === undefined && !isAppAssistantThread(thread)
      && (!options?.origin || options.origin === "all" || threadOriginBucket(thread) === options.origin));
    if (!rows.length) return;
    // A pending next-page response must not overwrite the inserted row.
    await client.cancelQueries({ queryKey: query.queryKey, exact: true });
    client.setQueryData<InfiniteData<ListThreadsResponse>>(query.queryKey, current => current && ({
      ...current, pages: current.pages.map((page, index) => index ? page : ({
        ...page, threads: [...new Map([...rows, ...page.threads].map(thread => [thread.id, thread])).values()],
      })),
    }));
  }));
}
