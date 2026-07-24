import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useThreads, useDismissThread, useReactivateThread, useRenameThread } from '@/api/threads';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/api/client';
import { formatChannelLabel } from '@valet/sdk';
import { getChannelIcon } from '@valet/sdk/ui';
import type { SessionThread } from '@/api/types';
import { cn } from '@/lib/cn';
import {
  DEFAULT_THREAD_ORIGIN_BUCKET,
  getThreadOriginBucket,
  mergeBucketCounts,
  THREAD_ORIGIN_BUCKETS,
  type ThreadOriginBucketId,
} from './thread-origin-buckets';

// ─── Unread Tracking ──────────────────────────────────────────────────────────

function getLastViewed(threadId: string): number {
  try {
    const raw = localStorage.getItem(`thread-last-viewed:${threadId}`);
    return raw ? Number(raw) : 0;
  } catch { return 0; }
}

function setLastViewed(threadId: string) {
  try {
    localStorage.setItem(`thread-last-viewed:${threadId}`, String(Date.now()));
  } catch { /* ignore */ }
}

// ─── Collapse State ───────────────────────────────────────────────────────────

function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('thread-sidebar-collapsed') === 'true';
  } catch { return false; }
}

function setSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem('thread-sidebar-collapsed', String(collapsed));
  } catch { /* ignore */ }
}

// ─── Active Bucket Persistence ────────────────────────────────────────────────

const ACTIVE_BUCKET_KEY = 'thread-sidebar-bucket';

function getStoredActiveBucket(): ThreadOriginBucketId {
  try {
    const raw = localStorage.getItem(ACTIVE_BUCKET_KEY);
    if (raw && THREAD_ORIGIN_BUCKETS.some((b) => b.id === raw)) {
      return raw as ThreadOriginBucketId;
    }
  } catch { /* ignore */ }
  return DEFAULT_THREAD_ORIGIN_BUCKET;
}

function setStoredActiveBucket(bucket: ThreadOriginBucketId) {
  try {
    localStorage.setItem(ACTIVE_BUCKET_KEY, bucket);
  } catch { /* ignore */ }
}

// ─── Channel Label Resolution ─────────────────────────────────────────────────

function useResolvedChannelLabels(threads: SessionThread[]): Map<string, string> {
  const resolvable = useMemo(() => {
    const seen = new Set<string>();
    const result: { channelType: string; channelId: string }[] = [];
    for (const t of threads) {
      const target = getThreadGroupTarget(t);
      if (target.channelType === 'web' || target.channelType === 'automation') continue;
      const key = `${target.channelType}:${target.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ channelType: target.channelType, channelId: target.channelId });
    }
    return result;
  }, [threads]);

  const results = useQueries({
    queries: resolvable.map((ch) => ({
      queryKey: ['channel-label', ch.channelType, ch.channelId] as const,
      queryFn: () => api.get<{ label: string | null }>(
        `/channels/label?channelType=${encodeURIComponent(ch.channelType)}&channelId=${encodeURIComponent(ch.channelId)}`
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
    })),
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < resolvable.length; i++) {
      const ch = resolvable[i];
      const result = results[i];
      if (result.data?.label) {
        map.set(`${ch.channelType}:${ch.channelId}`, result.data.label);
      }
    }
    return map;
  }, [resolvable, results]);
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

interface ThreadGroup {
  channelKey: string;
  channelType: string;
  channelId: string;
  label: string;
  threads: SessionThread[];
}

function getThreadGroupTarget(thread: SessionThread): { channelType: string; channelId: string; labelOverride?: string } {
  if (thread.originType === 'automation') {
    return { channelType: 'automation', channelId: 'default', labelOverride: 'Automations' };
  }
  if (thread.originType === 'web') {
    return { channelType: 'web', channelId: 'default' };
  }
  if (thread.originChannelType && thread.originChannelId) {
    return { channelType: thread.originChannelType, channelId: thread.originChannelId };
  }
  if (thread.originType && thread.originType !== 'thread') {
    return { channelType: thread.originType, channelId: thread.originChannelId || 'default' };
  }
  return {
    channelType: thread.channelType || 'web',
    channelId: thread.channelId || 'default',
  };
}

export function groupThreadsByChannel(
  threads: SessionThread[],
  resolvedLabels: Map<string, string>
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();

  for (const thread of threads) {
    const target = getThreadGroupTarget(thread);
    const key = `${target.channelType}:${target.channelId}`;

    if (!groups.has(key)) {
      const resolved = resolvedLabels.get(key);
      const label = target.labelOverride || resolved || formatChannelLabel(target.channelType, target.channelId);
      groups.set(key, {
        channelKey: key,
        channelType: target.channelType,
        channelId: target.channelId,
        label,
        threads: [],
      });
    }
    groups.get(key)!.threads.push(thread);
  }

  const priority = (type: string) => type === 'web' ? 0 : type === 'automation' ? 1 : 2;

  return Array.from(groups.values()).sort((a, b) => {
    const priorityDiff = priority(a.channelType) - priority(b.channelType);
    if (priorityDiff !== 0) return priorityDiff;
    return a.label.localeCompare(b.label);
  });
}

// ─── Thread Item ──────────────────────────────────────────────────────────────

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onDismiss,
  isDismissed,
  sessionId,
  requiresResponse,
}: {
  thread: SessionThread;
  isActive: boolean;
  onSelect: () => void;
  onDismiss?: () => void;
  isDismissed?: boolean;
  sessionId: string;
  requiresResponse?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);
  const renameThread = useRenameThread(sessionId);

  const lastViewed = getLastViewed(thread.id);
  const threadLastActive = new Date(thread.lastActiveAt).getTime();
  const hasUnread = !isActive && threadLastActive > lastViewed && thread.messageCount > 0;

  const startEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    savedRef.current = false;
    setEditValue(thread.title || thread.firstMessagePreview || '');
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [thread.title, thread.firstMessagePreview]);

  const saveTitle = useCallback(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    const trimmed = editValue.trim();
    if (trimmed !== (thread.title || '')) {
      renameThread.mutate({ threadId: thread.id, title: trimmed });
    }
    setIsEditing(false);
  }, [editValue, thread.title, thread.id, renameThread]);

  if (isEditing) {
    return (
      <div className="px-2 py-1">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTitle();
            if (e.key === 'Escape') { savedRef.current = true; setIsEditing(false); }
          }}
          onBlur={saveTitle}
          className="w-full rounded border border-violet-300 bg-white px-1 py-0.5 text-[11px] text-neutral-900 outline-none focus:ring-1 focus:ring-violet-400 dark:border-violet-600 dark:bg-neutral-900 dark:text-neutral-100"
          autoFocus
          maxLength={200}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[11px] transition-colors',
        isActive
          ? 'bg-surface-2 text-neutral-900 dark:bg-surface-3 dark:text-neutral-100'
          : 'text-neutral-500 hover:bg-surface-1 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-surface-2 dark:hover:text-neutral-200'
      )}
    >
      <span className="flex-1 truncate">
        {thread.title || thread.firstMessagePreview || 'New thread'}
      </span>
      {requiresResponse && !isDismissed && (
        <span
          className="inline-flex h-3 w-3 shrink-0 items-center justify-center text-amber-500 dark:text-amber-400"
          title="Response required"
        >
          <BellIcon className="h-2.5 w-2.5" />
          <span className="sr-only">Response required</span>
        </span>
      )}
      {hasUnread && !isDismissed && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
      )}
      <span
        role="button"
        tabIndex={-1}
        onClick={startEditing}
        className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
        title="Rename"
      >
        <PencilIcon className="h-2.5 w-2.5" />
      </span>
      {onDismiss && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
        >
          <XIcon className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );
}

// ─── Thread Origin Tabs ───────────────────────────────────────────────────────

function ThreadOriginTabs({
  activeBucket,
  bucketCounts,
  onSelectBucket,
}: {
  activeBucket: ThreadOriginBucketId;
  bucketCounts: ReturnType<typeof mergeBucketCounts>;
  onSelectBucket: (bucket: ThreadOriginBucketId) => void;
}) {
  // Layout notes (fixing Conner's "UI 9   SLACK 2   AUTOMATION 9   OTHER"
  // cramped/uneven feedback):
  //   - Each tab is flex-1 with `min-w-0` so long labels ("Automation") don't
  //     force one tab to eat sibling space.
  //   - Label + count are one grouped unit (`inline-flex gap-1`), then the
  //     tab centers that unit — so the label+count pair reads as one thing
  //     instead of two spaced-out tokens.
  //   - Count is always a pill (never inline text) so the visual rhythm is
  //     the same across active/inactive/attention states — just the color
  //     changes.
  //   - `px-1` per tab is tight because the sidebar is 210px wide and we
  //     have to fit 4 tabs.
  return (
    <div
      role="tablist"
      aria-label="Thread origin"
      className="flex shrink-0 items-stretch border-b border-neutral-100 bg-surface-0 dark:border-neutral-800/50"
    >
      {THREAD_ORIGIN_BUCKETS.map((bucket) => {
        const counts = bucketCounts[bucket.id];
        const isActive = bucket.id === activeBucket;
        const hasAttention = counts.attentionNeeded > 0;
        const showAttentionBadge = hasAttention && !isActive;
        return (
          <button
            key={bucket.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            title={
              showAttentionBadge
                ? `${bucket.description} — ${counts.attentionNeeded} needs response`
                : bucket.description
            }
            onClick={() => onSelectBucket(bucket.id)}
            className={cn(
              'group flex min-w-0 flex-1 items-center justify-center px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
              isActive
                ? 'border-b-2 border-violet-500 text-neutral-800 dark:text-neutral-100'
                : 'border-b-2 border-transparent text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300',
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate">{bucket.label}</span>
              {counts.total > 0 && (
                <span
                  className={cn(
                    'inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums',
                    showAttentionBadge
                      ? 'bg-amber-500 text-white dark:bg-amber-400 dark:text-neutral-900'
                      : isActive
                        ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                  )}
                >
                  {counts.total}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Thread Group Header ──────────────────────────────────────────────────────

function ThreadGroupHeader({ group }: { group: ThreadGroup }) {
  const Icon = getChannelIcon(group.channelType);
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
      <Icon className="h-2.5 w-2.5" />
      <span className="truncate">{group.label}</span>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface ThreadSidebarProps {
  sessionId: string;
  activeThreadId: string | null;
  responseRequiredThreadIds?: ReadonlySet<string>;
  /**
   * Optional best-effort map from a response-required threadId to the origin
   * bucket its interactive prompt came from (see `attentionBucketFromPrompt`).
   * Only used for threads NOT in the currently-loaded bucket page, so the
   * amber "needs response" badge still lights up the right tab across
   * unfetched buckets. When the thread IS loaded the authoritative bucket
   * comes from the thread row itself.
   */
  attentionBucketHint?: ReadonlyMap<string, ThreadOriginBucketId>;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
}

// How many threads to fetch at once for a given bucket. Sized to fill the
// visible sidebar height on a normal display (each thread row is ~24px + group
// headers) with headroom for `Load more`.
const SIDEBAR_PAGE_SIZE = 30;

export function ThreadSidebar({
  sessionId,
  activeThreadId,
  responseRequiredThreadIds,
  attentionBucketHint,
  onSelectThread,
  onNewThread,
}: ThreadSidebarProps) {
  const [collapsed, setCollapsed] = useState(getSidebarCollapsed);
  const [showDismissed, setShowDismissed] = useState(false);
  const [activeBucket, setActiveBucket] = useState<ThreadOriginBucketId>(getStoredActiveBucket);
  // Load-more state — measured in units of `SIDEBAR_PAGE_SIZE`. Reset when
  // switching buckets so a bucket doesn't inherit a stale deep-scroll from
  // another bucket.
  const [pagesForActiveBucket, setPagesForActiveBucket] = useState(1);

  // Fetch ONLY the active bucket — each bucket paginates independently so a
  // busy Automation bucket can't starve Slack/UI/Other of visible threads.
  // `includeOriginCounts` is implicitly true when `bucket` is set (worker
  // computes it either way in that case), but pass explicitly to be safe.
  const { data: threadData } = useThreads(sessionId, {
    bucket: activeBucket,
    pageSize: SIDEBAR_PAGE_SIZE * pagesForActiveBucket,
    includeOriginCounts: true,
  });
  const dismissThread = useDismissThread(sessionId);
  const reactivateThread = useReactivateThread(sessionId);

  // ALSO fetch dismissed threads (archived) unfiltered by bucket — the
  // "Dismissed" section at the bottom shows an aggregate count and list
  // across all origins, matching pre-existing behavior. Skip the bucket
  // filter here so the dismissed count is authoritative.
  const { data: dismissedData } = useThreads(sessionId, {
    pageSize: SIDEBAR_PAGE_SIZE,
  });

  const bucketedThreads = threadData?.threads ?? [];
  const activeBucketThreads = useMemo(
    () => bucketedThreads.filter((t) => t.status === 'active'),
    [bucketedThreads],
  );
  const dismissedThreads = useMemo(
    () => (dismissedData?.threads ?? []).filter((t) => t.status === 'archived'),
    [dismissedData],
  );
  const hasMoreInBucket = !!threadData?.hasMore;

  const bucketCounts = useMemo(
    () =>
      mergeBucketCounts(
        threadData?.originCounts,
        activeBucketThreads,
        responseRequiredThreadIds,
        attentionBucketHint,
      ),
    [threadData?.originCounts, activeBucketThreads, responseRequiredThreadIds, attentionBucketHint],
  );

  const resolvedLabels = useResolvedChannelLabels(activeBucketThreads);
  const groups = useMemo(
    () => groupThreadsByChannel(activeBucketThreads, resolvedLabels),
    [activeBucketThreads, resolvedLabels],
  );

  const handleSelectBucket = useCallback((bucket: ThreadOriginBucketId) => {
    setActiveBucket(bucket);
    setStoredActiveBucket(bucket);
    setPagesForActiveBucket(1);
  }, []);

  const handleLoadMore = useCallback(() => {
    setPagesForActiveBucket((n) => n + 1);
  }, []);

  // If the active thread lives in a bucket other than the currently selected
  // one (e.g. because the user just picked a thread from search or a link),
  // switch the tab so the selection is visible instead of silently hidden.
  // Only fires when the active thread is loaded in the current bucket page —
  // when it isn't, the caller (chat-container) is expected to have already
  // pointed the sidebar at the right bucket via localStorage on select.
  useEffect(() => {
    if (!activeThreadId) return;
    const activeThread = activeBucketThreads.find((t) => t.id === activeThreadId);
    if (!activeThread) return;
    const desired = getThreadOriginBucket(activeThread);
    if (desired !== activeBucket) {
      setActiveBucket(desired);
      setStoredActiveBucket(desired);
      setPagesForActiveBucket(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  useEffect(() => {
    if (activeThreadId) setLastViewed(activeThreadId);
  }, [activeThreadId]);

  const handleDismiss = useCallback(
    (threadId: string) => {
      dismissThread.mutate(threadId);
      if (threadId === activeThreadId) {
        const remaining = activeBucketThreads.filter((t) => t.id !== threadId);
        if (remaining.length > 0) {
          onSelectThread(remaining[0].id);
        }
      }
    },
    [dismissThread, activeThreadId, activeBucketThreads, onSelectThread]
  );

  const handleReactivate = useCallback(
    (threadId: string) => {
      reactivateThread.mutate(threadId);
      onSelectThread(threadId);
    },
    [reactivateThread, onSelectThread]
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setSidebarCollapsed(next);
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="p-2 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          title="Expand threads"
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-[210px] shrink-0 flex-col border-r border-neutral-200 bg-surface-0 dark:border-neutral-800 dark:bg-surface-0">
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/50">
        <span className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
          Threads
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNewThread}
            className="rounded p-0.5 text-violet-500 transition-colors hover:bg-violet-50 dark:hover:bg-violet-950/30"
            title="New thread"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Collapse sidebar"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ThreadOriginTabs
        activeBucket={activeBucket}
        bucketCounts={bucketCounts}
        onSelectBucket={handleSelectBucket}
      />

      <div className="flex-1 overflow-y-auto px-1 py-1">
        {groups.map((group) => (
          <div key={group.channelKey}>
            <ThreadGroupHeader group={group} />
            {group.threads.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                isActive={thread.id === activeThreadId}
                requiresResponse={responseRequiredThreadIds?.has(thread.id)}
                onSelect={() => onSelectThread(thread.id)}
                onDismiss={() => handleDismiss(thread.id)}
                sessionId={sessionId}
              />
            ))}
          </div>
        ))}
        {activeBucketThreads.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
            {bucketCounts[activeBucket].total === 0
              ? `No ${activeBucket === 'ui' ? 'UI' : activeBucket === 'other' ? 'other' : activeBucket} threads`
              : 'Loading…'}
          </div>
        )}
        {hasMoreInBucket && activeBucketThreads.length > 0 && (
          <button
            type="button"
            onClick={handleLoadMore}
            className="mt-1 flex w-full items-center justify-center px-2 py-1.5 text-[10px] font-medium text-neutral-500 transition-colors hover:bg-surface-1 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-surface-2 dark:hover:text-neutral-200"
          >
            Load more
          </button>
        )}
      </div>

      {dismissedThreads.length > 0 && (
        <div className="border-t border-neutral-100 dark:border-neutral-800/50">
          <button
            type="button"
            onClick={() => setShowDismissed(!showDismissed)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <span>Dismissed</span>
            <span className="tabular-nums">{dismissedThreads.length}</span>
          </button>
          {showDismissed && (
            <div className="px-1 pb-1">
              {dismissedThreads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={false}
                  onSelect={() => handleReactivate(thread.id)}
                  isDismissed
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />
    </svg>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  );
}
