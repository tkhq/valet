import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SessionThread, ListThreadsResponse, Message } from './types';
import type { ThreadOriginBucketId } from '@valet/shared';

export type PaginatedThreadsResponse = ListThreadsResponse & {
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
};

export const threadKeys = {
  all: ['threads'] as const,
  lists: () => [...threadKeys.all, 'list'] as const,
  list: (
    sessionId: string,
    page?: number,
    pageSize?: number,
    bucket?: ThreadOriginBucketId,
    includeOriginCounts?: boolean,
  ) =>
    [
      ...threadKeys.lists(),
      sessionId,
      page ?? null,
      pageSize ?? null,
      bucket ?? null,
      !!includeOriginCounts,
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
    ),
    queryFn: () => api.get<PaginatedThreadsResponse>(buildThreadsUrl(sessionId, options)),
    enabled: !!sessionId,
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
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
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
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
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
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
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
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
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
      queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionId) });
      queryClient.invalidateQueries({ queryKey: threadKeys.details() });
    },
  });
}
