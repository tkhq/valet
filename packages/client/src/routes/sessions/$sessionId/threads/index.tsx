import { createFileRoute, Link } from '@tanstack/react-router';
import { useThreads } from '@/api/threads';
import { formatRelativeTime } from '@/lib/format';
import { getThreadHistoryPages } from '../../-thread-history-pagination';
import {
  DEFAULT_THREAD_ORIGIN_BUCKET,
  THREAD_ORIGIN_BUCKETS,
  type ThreadOriginBucketId,
} from '@/components/chat/thread-origin-buckets';
import { cn } from '@/lib/cn';

function isBucket(value: unknown): value is ThreadOriginBucketId {
  return typeof value === 'string' && THREAD_ORIGIN_BUCKETS.some((b) => b.id === value);
}

export const Route = createFileRoute('/sessions/$sessionId/threads/')({
  component: ThreadHistoryPage,
  validateSearch: (search: Record<string, unknown>): { page?: number; bucket?: ThreadOriginBucketId } => ({
    page: typeof search.page === 'number'
      ? search.page
      : typeof search.page === 'string'
        ? parseInt(search.page, 10)
        : undefined,
    bucket: isBucket(search.bucket) ? search.bucket : undefined,
  }),
});

const EMPTY_ORIGIN_COUNTS = { ui: 0, slack: 0, automation: 0, other: 0 };

function ThreadHistoryPage() {
  const { sessionId } = Route.useParams();
  const { page, bucket: bucketParam } = Route.useSearch();
  const bucket: ThreadOriginBucketId = bucketParam ?? DEFAULT_THREAD_ORIGIN_BUCKET;
  const safePage = typeof page === 'number' && Number.isFinite(page) && page > 0 ? page : 1;
  // Server-side bucket filter — each bucket paginates independently and the
  // response's `originCounts` gives TRUE per-bucket totals for tab labels.
  const { data, isLoading, isError } = useThreads(sessionId, {
    page: safePage,
    pageSize: 30,
    bucket,
    includeOriginCounts: true,
  });

  const threads = data?.threads ?? [];
  const totalPages = data?.totalPages ?? 1;
  const pages = getThreadHistoryPages(safePage, totalPages);
  const originCounts = data?.originCounts ?? EMPTY_ORIGIN_COUNTS;

  // Server already filtered by bucket — no client-side filtering needed.
  const filteredThreads = threads;
  const bucketHasNoResults = !isLoading && !isError && filteredThreads.length === 0;
  const hasAnyThreadsInBucket = originCounts[bucket] > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            className="font-mono text-[11px] text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            &larr; Back
          </Link>
          <h1 className="font-mono text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            Thread History
          </h1>
        </div>
      </div>

      {/* Tab bar — counts come from server originCounts (true totals across
          all threads for the session/user, independent of the current bucket
          filter). */}
      <div
        role="tablist"
        aria-label="Thread origin"
        className="flex shrink-0 items-stretch gap-1 border-b border-border/60 px-5"
      >
        {THREAD_ORIGIN_BUCKETS.map((b) => {
          const isActive = b.id === bucket;
          const total = originCounts[b.id];
          return (
            <Link
              key={b.id}
              role="tab"
              aria-selected={isActive}
              to="/sessions/$sessionId/threads"
              params={{ sessionId }}
              // Reset page to 1 when switching tabs — otherwise pagination cursors
              // can leave the user on an empty page.
              search={{ page: 1, bucket: b.id }}
              title={b.description}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-2 font-mono text-[11px] font-medium transition-colors',
                isActive
                  ? 'border-b-2 border-accent text-neutral-800 dark:text-neutral-100'
                  : 'border-b-2 border-transparent text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200',
              )}
            >
              <span>{b.label}</span>
              {total > 0 && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums',
                    isActive
                      ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                  )}
                >
                  {total}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 py-8">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-transparent dark:border-neutral-600 dark:border-t-transparent" />
            <span className="font-mono text-[11px] text-neutral-400">Loading threads...</span>
          </div>
        )}

        {isError && (
          <div className="py-8 text-center font-mono text-[11px] text-red-500">
            Failed to load threads.
          </div>
        )}

        {bucketHasNoResults && !hasAnyThreadsInBucket && (
          <div className="py-8 text-center font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            No {bucket === 'ui' ? 'UI' : bucket === 'other' ? 'other' : bucket} threads yet.
          </div>
        )}

        {bucketHasNoResults && hasAnyThreadsInBucket && (
          <div className="py-8 text-center font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            No threads on this page. Try page 1.
          </div>
        )}

        {!isLoading && !isError && filteredThreads.length > 0 && (
          <>
            <div className="space-y-2">
              {filteredThreads.map((thread) => (
                <Link
                  key={thread.id}
                  to="/sessions/$sessionId/threads/$threadId"
                  params={{ sessionId, threadId: thread.id }}
                  className="group block rounded-md border border-border/60 bg-surface-1/40 px-4 py-3 transition-colors hover:bg-surface-1 dark:bg-surface-2/40 dark:hover:bg-surface-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-[12px] font-medium text-neutral-800 transition-colors group-hover:text-accent dark:text-neutral-200 dark:group-hover:text-accent">
                      {thread.title || thread.firstMessagePreview || 'Untitled thread'}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                      {formatRelativeTime(thread.lastActiveAt)}
                    </span>
                  </div>

                  {thread.title && thread.firstMessagePreview && (
                    <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {thread.firstMessagePreview}
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-3">
                    <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                      {thread.messageCount} {thread.messageCount === 1 ? 'message' : 'messages'}
                    </span>
                    {thread.summaryFiles > 0 && (
                      <span className="font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                        <span className="text-emerald-600 dark:text-emerald-400">+{thread.summaryAdditions}</span>
                        {' '}
                        <span className="text-red-500 dark:text-red-400">-{thread.summaryDeletions}</span>
                        {' '}across {thread.summaryFiles} {thread.summaryFiles === 1 ? 'file' : 'files'}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center gap-2">
                <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                  {data?.totalCount ?? threads.length} threads
                </span>
                <div className="flex items-center gap-1">
                  {pages.map((nextPage) => (
                    <Link
                      key={nextPage}
                      to="/sessions/$sessionId/threads"
                      params={{ sessionId }}
                      search={{ page: nextPage, bucket }}
                      className={[
                        'rounded border px-2 py-1 font-mono text-[10px] transition-colors',
                        nextPage === safePage
                          ? 'border-accent bg-accent text-white'
                          : 'border-border text-neutral-500 hover:bg-surface-1 dark:text-neutral-400 dark:hover:bg-surface-2',
                      ].join(' ')}
                    >
                      {nextPage}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
