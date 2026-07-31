import { useQueries, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SessionThread, ListThreadsResponse, Message } from './types';
import type { ThreadOriginBucketId, ThreadStatus } from '@valet/shared';
import { mergeThreadPages } from '@/components/chat/thread-origin-buckets';

export type PaginatedThreadsResponse = ListThreadsResponse & {
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
};

export const threadKeys = {
  all: ['threads'] as const,
  lists: () => [...threadKeys.all, 'list'] as const,
  /**
   * Prefix key covering EVERY list query for a session — any page size, bucket,
   * counts flag, or search term. Mutations must invalidate this rather than
   * `list(sessionId)`: react-query prefix-matches, and `list(sessionId)` is a
   * fully-specified key (page/pageSize/bucket/... all defaulted), so it does
   * NOT match the sidebar's paginated + bucket-filtered queries.
   */
  listsForSession: (sessionId: string) => [...threadKeys.lists(), sessionId] as const,
  list: (
    sessionId: string,
    page?: number,
    pageSize?: number,
    bucket?: ThreadOriginBucketId,
    includeOriginCounts?: boolean,
    search?: string,
    status?: ThreadStatus,
  ) =>
    [
      ...threadKeys.listsForSession(sessionId),
      page ?? null,
      pageSize ?? null,
      bucket ?? null,
      !!includeOriginCounts,
      search ?? null,
      status ?? null,
    ] as const,
  details: () => [...threadKeys.all, 'detail'] as const,
  detail: (sessionId: string, threadId: string) =>
    [...threadKeys.details(), sessionId, threadId] as const,
  active: (sessionId: string) => [...threadKeys.all, 'active', sessionId] as const,
};

export interface UseThreadsOptions {
  page?: number;
  pageSize?: number;
  /**
   * If set, the server filters the returned threads to this origin bucket.
   * Each bucket paginates INDEPENDENTLY — a busy Automation bucket can no
   * longer starve Slack/UI/Other of visible threads.
   */
  bucket?: ThreadOriginBucketId;
  /**
   * If true, response includes per-bucket TRUE totals (`originCounts`)
   * computed across all threads matching (session|user, status) regardless of
   * the `bucket` filter. Used to render tab-bar labels with real totals.
   *
   * NOTE: this is implicitly true when `bucket` is set. Set explicitly when
   * you want counts but no filter (e.g. an "all buckets" view).
   */
  includeOriginCounts?: boolean;
  /**
   * Free-text filter. The worker matches it case-insensitively against the
   * thread title AND the contents of the thread's messages (see
   * `packages/worker/src/lib/db/threads.ts`). Combines with `bucket`, so a
   * search stays scoped to the active tab.
   *
   * An older worker ignores the param and returns everything — callers must
   * pair this with the client-side fallback filter under detected skew (see
   * `filterThreadsBySearch`).
   */
  search?: string;
  /**
   * If set, the server returns only threads with this status. The `status`
   * param predates this branch, so it works against old and new workers alike
   * (no skew fallback needed). Used by the sidebar's Dismissed section to
   * fetch archived threads directly — filtering an unfiltered page client-side
   * would let active threads crowd every archived row out of the page.
   */
  status?: ThreadStatus;
}

function buildThreadsUrl(sessionId: string, options?: UseThreadsOptions): string {
  const params = new URLSearchParams();
  if (options?.page) {
    params.set('page', String(options.page));
    params.set('pageSize', String(options.pageSize ?? 30));
  } else if (options?.pageSize) {
    params.set('limit', String(options.pageSize));
  }
  if (options?.bucket) params.set('originBucket', options.bucket);
  if (options?.includeOriginCounts) params.set('includeOriginCounts', '1');
  if (options?.search) params.set('search', options.search);
  if (options?.status) params.set('status', options.status);
  const qs = params.toString();
  return `/sessions/${sessionId}/threads${qs ? `?${qs}` : ''}`;
}

export function useThreads(sessionId: string, options?: UseThreadsOptions) {
  return useQuery({
    queryKey: threadKeys.list(
      sessionId,
      options?.page,
      options?.pageSize,
      options?.bucket,
      options?.includeOriginCounts,
      options?.search,
      options?.status,
    ),
    queryFn: () => api.get<PaginatedThreadsResponse>(buildThreadsUrl(sessionId, options)),
    enabled: !!sessionId,
  });
}

export interface UseThreadPagesOptions extends Omit<UseThreadsOptions, 'page'> {
  /**
   * 1-based OFFSET page numbers to hold loaded simultaneously — typically
   * `[1..n]` where `n` is the `Load more` counter (see `planBucketFetch`).
   * Each page is its own react-query entry, so growing this array fetches ONLY
   * the new page and leaves the already-rendered ones untouched.
   */
  pages: readonly number[];
}

export interface ThreadPagesResult {
  /** All loaded pages merged newest-first and de-duplicated by thread id. */
  threads: SessionThread[];
  /** Page 1's response — the source for `originCounts` and the skew probe. */
  firstPage: PaginatedThreadsResponse | undefined;
  /**
   * `hasMore` from the HIGHEST-numbered page that has data. Page 1's flag only
   * says "more exist after page 1" and would keep `Load more` alive forever;
   * the last loaded page's flag is the real end-of-list signal.
   */
  hasMore: boolean;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Merge the per-page query results into one `ThreadPagesResult`.
 *
 * Hoisted to module scope on purpose: react-query only skips re-running
 * `combine` when the function itself is referentially stable, and an inline
 * arrow would rebuild the merged array on every render of the sidebar.
 */
function combineThreadPages(
  results: readonly { data?: PaginatedThreadsResponse; isLoading: boolean; isError: boolean }[],
): ThreadPagesResult {
  const pages = results.map((r) => r.data);
  let lastLoaded: PaginatedThreadsResponse | undefined;
  for (const page of pages) {
    if (page) lastLoaded = page;
  }
  return {
    threads: mergeThreadPages(pages.map((p) => p?.threads)),
    firstPage: pages[0],
    hasMore: !!lastLoaded?.hasMore,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}

/**
 * Load `options.pages` offset pages of a thread list at once and merge them.
 *
 * This replaces round 4's single growing request. `pageSize` is CONSTANT across
 * pages (offsets must line up) and `Load more` appends a page number instead of
 * asking for a bigger page — which is what removes the
 * `MAX_THREADS_PER_REQUEST` ceiling that capped the sidebar. `page`/`pageSize`
 * are honored by pre-`originBucket` workers too, so this works under skew.
 *
 * `combine` keeps the returned object referentially stable while the underlying
 * query results are unchanged, so downstream `useMemo`s don't thrash.
 */
export function useThreadPages(
  sessionId: string,
  options: UseThreadPagesOptions,
): ThreadPagesResult {
  return useQueries({
    queries: options.pages.map((page) => ({
      queryKey: threadKeys.list(
        sessionId,
        page,
        options.pageSize,
        options.bucket,
        options.includeOriginCounts,
        options.search,
        options.status,
      ),
      queryFn: () =>
        api.get<PaginatedThreadsResponse>(
          buildThreadsUrl(sessionId, {
            page,
            pageSize: options.pageSize,
            bucket: options.bucket,
            includeOriginCounts: options.includeOriginCounts,
            search: options.search,
            status: options.status,
          }),
        ),
      enabled: !!sessionId,
    })),
    combine: combineThreadPages,
  });
}

export function useThread(sessionId: string, threadId: string) {
  return useQuery({
    queryKey: threadKeys.detail(sessionId, threadId),
    queryFn: async () => {
      const data = await api.get<{ thread: SessionThread; messages: Message[] }>(
        `/sessions/${sessionId}/threads/${threadId}`
      );
      return {
        ...data,
        messages: data.messages.map((m) => ({
          ...m,
          createdAt: new Date(m.createdAt),
        })),
      };
    },
    enabled: !!sessionId && !!threadId,
  });
}

export function useActiveThread(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: threadKeys.active(sessionId),
    queryFn: () =>
      api.get<{ thread: SessionThread }>(`/sessions/${sessionId}/threads/active`),
    select: (data) => data.thread,
    enabled: !!sessionId && enabled,
    staleTime: 30_000,
  });
}

export function useCreateThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<SessionThread>(`/sessions/${sessionId}/threads`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.listsForSession(sessionId) });
    },
  });
}

export function useContinueThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.post<{ thread: SessionThread; resumed: boolean; continuationContext?: string }>(
        `/sessions/${sessionId}/threads/${threadId}/continue`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.listsForSession(sessionId) });
    },
  });
}

export function useDismissThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.patch<{ thread: SessionThread }>(
        `/sessions/${sessionId}/threads/${threadId}`,
        { status: 'archived' }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.listsForSession(sessionId) });
    },
  });
}

export function useReactivateThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      api.patch<{ thread: SessionThread }>(
        `/sessions/${sessionId}/threads/${threadId}`,
        { status: 'active' }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.listsForSession(sessionId) });
    },
  });
}

export function useRenameThread(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) =>
      api.patch<{ thread: SessionThread }>(
        `/sessions/${sessionId}/threads/${threadId}`,
        { title }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: threadKeys.listsForSession(sessionId) });
      queryClient.invalidateQueries({ queryKey: threadKeys.details() });
    },
  });
}
