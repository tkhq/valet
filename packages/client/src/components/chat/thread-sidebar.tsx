import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  useThread,
  useThreadPages,
  useThreads,
  useDismissThread,
  useReactivateThread,
  useRenameThread,
} from '@/api/threads';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useDebounced } from '@/hooks/use-debounced';
import { formatChannelLabel } from '@valet/sdk';
import { getChannelIcon } from '@valet/sdk/ui';
import type { SessionThread } from '@/api/types';
import { cn } from '@/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  backendIgnoredBucketFilter,
  DEFAULT_THREAD_ORIGIN_BUCKET,
  filterThreadsByBucket,
  filterThreadsBySearch,
  getThreadOriginBucket,
  mergeBucketCounts,
  normalizeSearchTerm,
  planBucketFetch,
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

// ─── Fetched-Page Selection ───────────────────────────────────────────────────

/**
 * Non-archived threads from a fetched page, across ALL buckets present in the
 * payload. Used for tab COUNTS and attention badges — deliberately not
 * bucket-scoped, so that when the worker returns every bucket (either because
 * no `originBucket` filter was sent, or because it's an older build that
 * ignores the param) the other tabs still get real counts instead of zeroes.
 */
export function selectActiveThreads(
  fetched: readonly SessionThread[],
): SessionThread[] {
  return fetched.filter((t) => t.status === 'active');
}

/**
 * The threads the sidebar actually RENDERS for `bucket`.
 *
 * Applies the bucket filter client-side on top of the server's `originBucket`
 * filter. See `filterThreadsByBucket` for why that redundancy is load-bearing:
 * without it, a worker that predates `originBucket` support returns every
 * bucket and the sidebar renders all origins under the selected tab.
 */
export function selectVisibleBucketThreads(
  fetched: readonly SessionThread[],
  bucket: ThreadOriginBucketId,
): SessionThread[] {
  return filterThreadsByBucket(selectActiveThreads(fetched), bucket);
}

export interface VisibleBucketPage {
  /** Active threads in `bucket`, capped at `plan.visibleLimit`. */
  threads: SessionThread[];
  /** Whether a `Load more` affordance should be offered. */
  hasMore: boolean;
}

/**
 * Bucket-filter (via `selectVisibleBucketThreads`), optionally apply the
 * skew-only client-side search filter, then CAP the accumulated pages to what
 * the tab should actually render.
 *
 * The cap is what makes "max 30 threads per tab by default" hold under
 * backend skew, where `planBucketFetch` deliberately requests
 * `SKEW_OVERFETCH_FACTOR`x bigger MIXED pages than we intend to show so that
 * the client-side filter has enough material to fill the tab.
 *
 * `hasMore` — ROUND 5. This is the site of the "exactly 30 threads and no
 * more" bug. The old derivation was:
 *
 *     all.length > threads.length || (serverHasMore && plan.pageSize < MAX_THREADS_PER_REQUEST)
 *
 * Both clauses go false as soon as the request has saturated the worker's
 * 100-row per-request clamp with everything held rendered — which under skew is
 * the FIRST page (`planBucketFetch` asks for `30 * 4` -> clamped to 100). A
 * bucket holding exactly `visibleLimit` rows in that window therefore rendered
 * 30 threads and hid `Load more` entirely, even with hundreds of threads left
 * server-side. The second clause existed because a bigger single request was
 * the only way to get more rows; now that `Load more` advances OFFSET pages
 * instead of growing one request, there is no ceiling and no reason to suppress
 * the affordance.
 *
 * So `hasMore` is true when EITHER:
 *  - we already hold more rows for this bucket than we render (overfetched, or
 *    a later page arrived) — `Load more` reveals them with no round-trip; or
 *  - the last loaded page reported `hasMore` — more rows exist server-side and
 *    the next offset page will fetch them.
 *
 * `serverHasMore` MUST be the flag from the HIGHEST-numbered loaded page (see
 * `useThreadPages`), not page 1's — page 1 says "more exist after page 1",
 * which stays true forever and would make `Load more` immortal.
 */
export function selectVisibleBucketPage(
  fetched: readonly SessionThread[],
  bucket: ThreadOriginBucketId,
  plan: { visibleLimit: number },
  serverHasMore: boolean,
  /**
   * Search term to apply CLIENT-SIDE, or undefined to skip. Pass this ONLY
   * when backend skew is detected — see `filterThreadsBySearch` for why
   * applying it against a new worker would drop legitimate contents matches.
   * Applied BEFORE the cap so a filtered tab still fills to `visibleLimit`.
   */
  clientSearch?: string,
): VisibleBucketPage {
  const inBucket = selectVisibleBucketThreads(fetched, bucket);
  const all = clientSearch ? filterThreadsBySearch(inBucket, clientSearch) : inBucket;
  const threads = all.slice(0, plan.visibleLimit);
  const hasMore = all.length > threads.length || serverHasMore;
  return { threads, hasMore };
}

/** Human label for a bucket used in the sidebar's empty states. */
function bucketNoun(bucket: ThreadOriginBucketId): string {
  if (bucket === 'ui') return 'UI';
  if (bucket === 'other') return 'other';
  return bucket;
}

/**
 * Which message the thread list shows when it renders zero rows.
 *
 * Four genuinely different situations, and conflating them is how a sidebar
 * lies to you:
 *  - still fetching -> "Loading…";
 *  - searching, nothing matched, nothing left to fetch -> "No threads match";
 *  - nothing rendered but more pages exist (a MIXED page under skew can contain
 *    none of the active bucket) -> say so, and keep `Load more` available;
 *  - the bucket is genuinely empty -> "No X threads".
 */
export function threadListEmptyMessage({
  isLoading,
  hasMore,
  searching,
  bucket,
  bucketTotal,
}: {
  isLoading: boolean;
  hasMore: boolean;
  searching: boolean;
  bucket: ThreadOriginBucketId;
  /** Server-reported total for the bucket (already search-scoped when searching). */
  bucketTotal: number;
}): string {
  if (isLoading) return 'Loading…';
  if (hasMore) {
    return searching ? 'No matches on these threads yet' : 'None on these threads yet';
  }
  if (searching) return 'No threads match';
  if (bucketTotal === 0) return `No ${bucketNoun(bucket)} threads`;
  // Counts say the bucket is non-empty but we hold nothing and there's nothing
  // more to fetch — a transient between an invalidation and the refetch.
  return 'Loading…';
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
  const [menuOpen, setMenuOpen] = useState(false);
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

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle 'A' or 'a' key to archive when menu is open
    if (e.key === 'A' || e.key === 'a') {
      e.preventDefault();
      onDismiss?.();
      setMenuOpen(false);
    }
  }, [onDismiss]);

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
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); }}
              className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
              title="Thread options"
            >
              <EllipsisIcon className="h-2.5 w-2.5" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40" onKeyDown={handleMenuKeyDown}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
                setMenuOpen(false);
              }}
            >
              <span className="flex-1">Archive</span>
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">A</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </button>
  );
}

// ─── Thread Origin Tabs ───────────────────────────────────────────────────────

/**
 * Bound the count pill to at most 3 glyphs ("99+"). Keeps the tab-bar width
 * math deterministic no matter how many threads a bucket accumulates — an
 * unbounded 4-digit count is what would push a label back into truncating.
 */
export function formatTabCount(total: number): string {
  return total > 99 ? '99+' : String(total);
}

function ThreadOriginTabs({
  activeBucket,
  bucketCounts,
  onSelectBucket,
}: {
  activeBucket: ThreadOriginBucketId;
  bucketCounts: ReturnType<typeof mergeBucketCounts>;
  onSelectBucket: (bucket: ThreadOriginBucketId) => void;
}) {
  // Layout notes — round 3 fixes Conner's "UI 12 | SL… 2 | AU… 16 | OTHER"
  // truncation. Truncating a 5-char label to "SL…" costs more width in
  // ellipsis than it saves, so the fix is to make labels that FIT rather than
  // to let them shrink.
  //
  // Width budget at the 248px sidebar:
  //   248px container / 4 tabs           = 62.0px per tab
  //   - px-0.5 both sides (2+2)          = 58.0px content box
  //   worst-case content ("SLACK"/"OTHER" + 2-digit pill):
  //     5 chars x ~6.6px (10px semibold, normal tracking) = 33.0px
  //     + gap-1                                           =  4.0px
  //     + pill (min-w-[16px], px-1, 2-digit cap)          = 16.0px
  //                                                   total 53.0px  <= 58.0 ✓
  //
  // Levers used to get there, in order of impact:
  //   - `tracking-wider` DROPPED. At 0.05em it added ~0.5px/char — ~5px across
  //     "AUTOMATION" — for no legibility gain at 10px.
  //   - `shortLabel` (<=5 chars: UI / SLACK / AUTO / OTHER) instead of `label`.
  //     "AUTOMATION" is 10 chars ≈ 72px and cannot fit at any sane sidebar
  //     width; the full name stays in the `title` tooltip + aria-label.
  //   - Counts >99 render as "99+" so the pill width is bounded and the math
  //     above stays true for any thread volume.
  //   - `truncate`/`min-w-0` REMOVED from the label. Since labels are sized to
  //     fit, shrinking is unnecessary — and removing it makes a mid-word
  //     ellipsis structurally impossible rather than merely unlikely.
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
            aria-label={bucket.description}
            onClick={() => onSelectBucket(bucket.id)}
            className={cn(
              'group flex flex-1 items-center justify-center px-0.5 py-1.5 text-[10px] font-semibold transition-colors',
              isActive
                ? 'border-b-2 border-violet-500 text-neutral-800 dark:text-neutral-100'
                : 'border-b-2 border-transparent text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300',
            )}
          >
            <span className="inline-flex items-center gap-1">
              <span className="whitespace-nowrap">{bucket.shortLabel}</span>
              {counts.total > 0 && (
                <span
                  className={cn(
                    'inline-flex h-3.5 min-w-[16px] shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums',
                    showAttentionBadge
                      ? 'bg-amber-500 text-white dark:bg-amber-400 dark:text-neutral-900'
                      : isActive
                        ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                  )}
                >
                  {formatTabCount(counts.total)}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Thread Search Field ──────────────────────────────────────────────────────

/**
 * Compact search input for the thread list, styled to sit under the tab bar
 * without competing with it: no border box, a single hairline separator, 11px
 * text matching `ThreadItem`, and the same muted neutral palette as the tabs.
 * The shared `components/ui/search-input` is deliberately not reused — it's
 * sized for full-width pages (text-sm, py-2, rounded border) and looks like a
 * form control dropped into a 248px sidebar.
 *
 * Debouncing lives in the parent (`useDebounced`) so the *query key* is what's
 * debounced, not the keystrokes — the input itself stays fully controlled and
 * therefore never lags behind typing.
 */
function ThreadSearchField({
  value,
  onChange,
  activeBucketLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  activeBucketLabel: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800/50">
      <SearchIcon className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
        placeholder={`Search ${activeBucketLabel}`}
        aria-label={`Search ${activeBucketLabel} threads by title or message contents`}
        maxLength={200}
        className="min-w-0 flex-1 border-none bg-transparent p-0 text-[11px] text-neutral-700 outline-none placeholder:text-neutral-400 focus:ring-0 dark:text-neutral-200 dark:placeholder:text-neutral-500 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear search"
          className="shrink-0 rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <XIcon className="h-2.5 w-2.5" />
          <span className="sr-only">Clear search</span>
        </button>
      )}
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

// Debounce for the search field. 250ms is short enough to feel live while
// typing and long enough that a normal typing burst is one request, not one per
// keystroke (each request is a D1 query with a messages-content LIKE).
const SEARCH_DEBOUNCE_MS = 250;

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
  // Whether the backend ignores our `originBucket` filter (frontend/worker
  // deploy skew). LATCHED in state rather than derived inline from the current
  // response — deriving it would oscillate: flipping the flag changes the
  // react-query key, so `threadData` goes undefined for the new key, which
  // would read as "not skewed" and flip us straight back. See
  // `backendIgnoredBucketFilter`.
  const [backendIgnoresBucket, setBackendIgnoresBucket] = useState(false);
  // Search field. `searchInput` is the raw keystroke state (so the input stays
  // responsive); `searchTerm` is the debounced value that actually drives the
  // query key.
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounced(searchInput, SEARCH_DEBOUNCE_MS);
  const searchTerm = normalizeSearchTerm(debouncedSearch);

  // Fetch ONLY the active bucket — each bucket paginates independently so a
  // busy Automation bucket can't starve Slack/UI/Other of visible threads.
  // Under skew we instead overfetch bigger MIXED pages (no bucket param) and
  // filter + cap client-side, so a tab still fills to SIDEBAR_PAGE_SIZE.
  const fetchPlan = useMemo(
    () =>
      planBucketFetch({
        bucket: activeBucket,
        pages: pagesForActiveBucket,
        basePageSize: SIDEBAR_PAGE_SIZE,
        skewed: backendIgnoresBucket,
      }),
    [activeBucket, pagesForActiveBucket, backendIgnoresBucket],
  );

  // `includeOriginCounts` is implicitly true when `bucket` is set (worker
  // computes it either way in that case), but pass explicitly — it's also our
  // skew probe, and under skew we omit `bucket` entirely.
  //
  // `useThreadPages` holds pages 1..N loaded at once and merges them. Load more
  // appends a page number rather than growing one request's `pageSize`, which is
  // what makes it unbounded — see `planBucketFetch` for the ceiling that used to
  // stop it dead at MAX_THREADS_PER_REQUEST.
  const threadPages = useThreadPages(sessionId, {
    bucket: fetchPlan.bucket,
    pages: fetchPlan.requestPages,
    pageSize: fetchPlan.requestPageSize,
    includeOriginCounts: true,
    search: searchTerm,
  });
  const threadData = threadPages.firstPage;

  // A response that carries `originCounts` proves the worker understands
  // `originBucket` (and therefore `search`); one that doesn't proves it doesn't.
  // Latch both directions so this self-heals the moment the new worker is
  // deployed.
  useEffect(() => {
    if (!threadData) return;
    setBackendIgnoresBucket(backendIgnoredBucketFilter(threadData));
  }, [threadData]);

  // A new search is a different result set — restart pagination at page 1 so we
  // don't hold offset pages computed against the previous filter.
  useEffect(() => {
    setPagesForActiveBucket(1);
  }, [searchTerm]);

  const dismissThread = useDismissThread(sessionId);
  const reactivateThread = useReactivateThread(sessionId);

  // ALSO fetch dismissed threads (archived) unfiltered by bucket — the
  // "Dismissed" section at the bottom shows an aggregate count and list
  // across all origins, matching pre-existing behavior. Skip the bucket
  // filter here so the dismissed count is authoritative.
  //
  // `status: 'archived'` is load-bearing: an unfiltered fetch returns the
  // newest 30 threads of ANY status, so in a busy session (30+ active threads
  // newer than the oldest archived one) active rows would crowd every archived
  // row out of the page and the Dismissed section would undercount or vanish.
  // The `status` param predates this branch, so it holds under deploy skew.
  const { data: dismissedData } = useThreads(sessionId, {
    pageSize: SIDEBAR_PAGE_SIZE,
    status: 'archived',
  });

  const fetchedThreads = threadPages.threads;
  // Everything active in the fetched pages (all buckets they happen to contain)
  // — feeds tab counts / attention badges.
  const activeThreads = useMemo(() => selectActiveThreads(fetchedThreads), [fetchedThreads]);
  // Under skew the worker ignores `search` too, so filter by title/preview
  // client-side. Against a NEW worker we must NOT — it can legitimately match
  // message contents that appear in neither field. See `filterThreadsBySearch`.
  const clientSearch = backendIgnoresBucket ? searchTerm : undefined;
  // What we RENDER: re-filtered to the active bucket client-side so a worker
  // without `originBucket` support can't leak other origins into this tab, then
  // CAPPED at `fetchPlan.visibleLimit` (30 per Load-more page) so overfetched
  // mixed pages don't blow past the per-tab default.
  // Uses `selectVisibleBucketPage` (not `filterThreadsByBucket` directly) so
  // the unit tests in thread-sidebar.test.ts cover this exact render path.
  const visibleBucketPage = useMemo(
    () =>
      selectVisibleBucketPage(
        fetchedThreads,
        activeBucket,
        fetchPlan,
        threadPages.hasMore,
        clientSearch,
      ),
    [fetchedThreads, activeBucket, fetchPlan, threadPages.hasMore, clientSearch],
  );
  const activeBucketThreads = visibleBucketPage.threads;
  const dismissedThreads = useMemo(
    () => (dismissedData?.threads ?? []).filter((t) => t.status === 'archived'),
    [dismissedData],
  );
  const hasMoreInBucket = visibleBucketPage.hasMore;

  const bucketCounts = useMemo(
    () =>
      mergeBucketCounts(
        threadData?.originCounts,
        activeThreads,
        responseRequiredThreadIds,
        attentionBucketHint,
      ),
    [threadData?.originCounts, activeThreads, responseRequiredThreadIds, attentionBucketHint],
  );

  const resolvedLabels = useResolvedChannelLabels(activeBucketThreads);
  const groups = useMemo(
    () => groupThreadsByChannel(activeBucketThreads, resolvedLabels),
    [activeBucketThreads, resolvedLabels],
  );

  const emptyStateMessage = useMemo(
    () =>
      threadListEmptyMessage({
        isLoading: threadPages.isLoading,
        hasMore: hasMoreInBucket,
        searching: !!searchTerm,
        bucket: activeBucket,
        bucketTotal: bucketCounts[activeBucket].total,
      }),
    [threadPages.isLoading, hasMoreInBucket, searchTerm, activeBucket, bucketCounts],
  );

  // Search is scoped to the active tab, so say which tab in the placeholder.
  const activeBucketLabel = useMemo(
    () => THREAD_ORIGIN_BUCKETS.find((b) => b.id === activeBucket)?.label ?? 'threads',
    [activeBucket],
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
  //
  // ONE-SHOT per activeThreadId, tracked in `resolvedTabForThread` rather than
  // by narrowing the dep array to `[activeThreadId]`. Re-running unguarded on
  // every data change would fight the user (a manual tab click would snap
  // straight back to the active thread's bucket), while the narrow dep array
  // had a cold-load race: on a permalink the effect fired once while the
  // thread list was still empty, bailed, and never re-ran when data arrived.
  //
  // The fetched pages can't resolve every case on their own: in the healthy
  // (non-skew) world they're server-filtered to the CURRENT bucket, so a
  // deep-linked thread from another bucket never appears in them at all. When
  // the pages don't contain the active thread, fetch its detail once
  // (`useThread` is disabled once resolved) and read the bucket off that row.
  const [resolvedTabForThread, setResolvedTabForThread] = useState<string | null>(null);
  const activeThreadFromPages = useMemo(
    () => (activeThreadId ? fetchedThreads.find((t) => t.id === activeThreadId) : undefined),
    [activeThreadId, fetchedThreads],
  );
  const needsActiveThreadLookup =
    !!activeThreadId && resolvedTabForThread !== activeThreadId && !activeThreadFromPages;
  const { data: activeThreadLookup } = useThread(
    sessionId,
    needsActiveThreadLookup && activeThreadId ? activeThreadId : '',
  );
  useEffect(() => {
    if (!activeThreadId || resolvedTabForThread === activeThreadId) return;
    const activeThread =
      activeThreadFromPages ??
      (activeThreadLookup?.thread.id === activeThreadId ? activeThreadLookup.thread : undefined);
    if (!activeThread) return;
    setResolvedTabForThread(activeThreadId);
    const desired = getThreadOriginBucket(activeThread);
    if (desired !== activeBucket) {
      setActiveBucket(desired);
      setStoredActiveBucket(desired);
      setPagesForActiveBucket(1);
    }
  }, [activeThreadId, resolvedTabForThread, activeThreadFromPages, activeThreadLookup, activeBucket]);

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
    // 248px (was 210px, +18%): the modest widening Conner asked for. Enough to
    // fit four non-truncating origin tabs (see the width math in
    // `ThreadOriginTabs`) without stealing meaningful room from the transcript.
    // Keep in sync with `ThreadSidebarFallback` in chat-container.tsx.
    <div className="flex w-[248px] shrink-0 flex-col border-r border-neutral-200 bg-surface-0 dark:border-neutral-800 dark:bg-surface-0">
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

      <ThreadSearchField
        value={searchInput}
        onChange={setSearchInput}
        activeBucketLabel={activeBucketLabel}
      />

      {/* `scrollbar-none` — Conner asked for no visible scrollbar here; the
          list still scrolls (wheel/trackpad/keyboard/touch), the track is just
          not painted. See the utility in styles/globals.css. */}
      <div className="scrollbar-none flex-1 overflow-y-auto px-1 py-1">
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
            {emptyStateMessage}
          </div>
        )}
        {/* NOT gated on `activeBucketThreads.length > 0`. Under skew a page of
            MIXED rows can contain none of the active bucket (or none matching
            the search) while later pages do — gating the button on a non-empty
            render would dead-end the list at the first barren page, which is the
            same class of bug as the `hasMore` one. */}
        {hasMoreInBucket && !threadPages.isLoading && (
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

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
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

function EllipsisIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}
