import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Archive, ArchiveRestore, MessageSquare, MoreHorizontal, Plus, RefreshCw, Search, X } from "lucide-react";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";
import {
  DEFAULT_THREAD_LIMIT,
  useArchivedThreads,
  useCreateThread,
  useReplaceSandbox,
  useSetThreadArchived,
  useThreads,
} from "~/api/queries";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useDismissChild, useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useStreamStore } from "~/stores/stream";
import { createDebouncer } from "~/lib/debounce";
import {
  bucketCounts,
  filterThreads,
  THREAD_ORIGIN_FILTERS,
  threadOriginBucket,
  type ThreadOriginBucket,
} from "~/lib/thread-origin";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";
import { cn } from "~/lib/cn";

/**
 * What an untitled thread is called.
 *
 * This used to be `Thread ${index + 1}`, which is a number that claims an
 * identity and then reassigns it: threads sort newest-first, so every new
 * thread pushed "Thread 5" down to "Thread 6" and renumbered every row
 * below it. At two threads nobody notices. At thirty it is a wall of
 * numbers that all move.
 *
 * A creation stamp never swaps between rows. It is also the only thing we
 * actually know about a thread nobody has titled and nothing has been said
 * in. The newest thread keeps a friendlier name because it is the one the
 * "New thread" button just created and is about to be typed into.
 */
export function untitledThreadLabel(thread: ThreadSummary, index: number): string {
  if (index === 0) return "New thread";
  return formatWhen(thread.createdAt);
}

const BUCKET_STORAGE_KEY = "valet:thread-bucket";

function loadStoredBucket(): ThreadOriginBucket {
  try {
    const raw = window.localStorage.getItem(BUCKET_STORAGE_KEY);
    if (raw && THREAD_ORIGIN_FILTERS.some((f) => f.id === raw)) return raw as ThreadOriginBucket;
  } catch {
    // Fall through.
  }
  return "all";
}

const CHILDREN_POLL_MS = 30_000;
const CHILDREN_INVALIDATE_DEBOUNCE_MS = 500;

/** Stable no-op so the live-update effect doesn't re-subscribe each render
 * when children are turned off. */
const NO_REFETCH = () => {};

/** Pure: groups children by the thread that spawned them. */
export function groupChildrenByThread(
  children: OrchestratorChildSummary[],
): Map<string, OrchestratorChildSummary[]> {
  const map = new Map<string, OrchestratorChildSummary[]>();
  for (const c of children) {
    const list = map.get(c.parentThreadId);
    if (list) list.push(c);
    else map.set(c.parentThreadId, [c]);
  }
  return map;
}

/** Pure: status-dot class for a child row. Calm-companion visual language —
 * running is moss with a subtle pulse, settled is a muted checkmark. */
export function childStatusDotClassName(status: OrchestratorChildSummary["status"]): string {
  return status === "running"
    ? "bg-moss animate-pulse motion-reduce:animate-none"
    : "bg-muted";
}

/**
 * Chat sidebar (assistant-centered web UI, decision 12): the assistant's
 * threads with children nested beneath the thread that spawned them.
 *
 * Design: no section header — the sidebar IS the threads list. "New
 * thread" is the first affordance (top of the list, where creation
 * belongs), rows are plain truncated titles with one active-state
 * treatment (moss left rail + soft ink wash), and the full title is
 * recoverable via hover tooltip when truncated.
 */
export function ThreadTree({ sessionId: override, showChildren = true }: ThreadTreeProps = {}) {
  const info = useOrchestratorInfo();
  // No `override` means the caller's own assistant — the original and still
  // the default behavior.
  const sessionId = override ?? info.data?.sessionId;

  if (!sessionId) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted">
        <Spinner size={14} />
      </div>
    );
  }

  return <ThreadTreeInner sessionId={sessionId} showChildren={showChildren} />;
}

export interface ThreadTreeProps {
  /** Whose threads to show. Defaults to the caller's own assistant. */
  sessionId?: string;
  /**
   * Nest child sessions under the thread that spawned them. Must be false
   * for any session other than the caller's own assistant:
   * `GET /api/orchestrator/children` resolves the CALLER's orchestrator
   * rather than `sessionId`, so leaving it on would nest the viewer's
   * personal children under someone else's threads.
   */
  showChildren?: boolean;
}

/** How many more threads each "Show more" press asks for. Starting at the
 * hook's default keeps the sidebar on the same cache entry as every other
 * reader of this list. */
const THREAD_PAGE = DEFAULT_THREAD_LIMIT;

function ThreadTreeInner({ sessionId, showChildren }: { sessionId: string; showChildren: boolean }) {
  // The list is capped server-side (V1 port #13) so an assistant whose
  // workflows have opened thousands of `signal:workflow:` threads does not
  // render every one. Measured sessions hold single digits, so almost
  // nobody ever presses the button below — it exists so the cap can never
  // hide a thread with no way back to it.
  const [limit, setLimit] = useState(THREAD_PAGE);
  const threadsQ = useThreads(sessionId, { limit });
  const childrenQ = useOrchestratorChildren({
    refetchInterval: CHILDREN_POLL_MS,
    enabled: showChildren,
  });
  // `refetch()` fires even on a disabled query, so gate the live-update
  // hook too rather than relying on `enabled` alone.
  useInvalidateChildrenOnQueueState(sessionId, showChildren ? childrenQ.refetch : NO_REFETCH);
  const createThread = useCreateThread(sessionId);
  const setArchived = useSetThreadArchived(sessionId);
  const replaceSandbox = useReplaceSandbox(sessionId);
  const dismissChild = useDismissChild();
  const [showArchived, setShowArchived] = useState(false);
  const [archivedLimit, setArchivedLimit] = useState(THREAD_PAGE);
  const archivedQ = useArchivedThreads(sessionId, { enabled: showArchived, limit: archivedLimit });
  const navigate = useNavigate({ from: "/chat" });

  const search = (useSearch({ strict: false }) ?? {}) as { thread?: string; child?: string };
  // Sorted by CREATION, newest first — deliberately not by last activity.
  //
  // Chat products sort history by last activity and it reads fine there,
  // because a document only moves when a person touches it. These rows are
  // agents that work while you look away, so an activity sort makes the
  // list reorder itself under the cursor: you look back and the thread you
  // were about to click has moved. Creation order is stable, so a thread
  // stays where you last saw it.
  //
  // This will look like a bug to anyone arriving from a chat app. It is
  // not. If recency is ever wanted, it belongs behind an explicit sort
  // control that is off by default.
  const threads = useMemo(
    () => [...(threadsQ.data?.threads ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [threadsQ.data],
  );
  const activeThreadId = search.thread ?? threads[0]?.id;
  // `total` counts what the session HAS; `threads` is what the cap returned.
  const total = threadsQ.data?.total ?? threads.length;
  const hiddenCount = Math.max(0, total - threads.length);
  const archivedLoaded = archivedQ.data?.threads.length ?? 0;
  const archivedTotal = archivedQ.data?.total ?? archivedLoaded;
  const archivedHidden = Math.max(0, archivedTotal - archivedLoaded);
  const grouped = groupChildrenByThread(showChildren ? (childrenQ.data?.children ?? []) : []);

  const [bucket, setBucket] = useState<ThreadOriginBucket>(() => loadStoredBucket());
  const [query, setQuery] = useState("");
  const counts = useMemo(() => bucketCounts(threads), [threads]);
  // Chips earn their row only when threads actually span buckets — a
  // chat-only session keeps the sidebar clean.
  const bucketsInUse = THREAD_ORIGIN_FILTERS.filter((f) => f.id !== "all" && counts[f.id] > 0);
  const showFilters = bucketsInUse.length > 1;
  const effectiveBucket = showFilters ? bucket : "all";
  const visible = useMemo(
    () => filterThreads(threads, effectiveBucket, query),
    [threads, effectiveBucket, query],
  );
  // Search and the origin chips run over the LOADED page, not the whole
  // session. That is fine while nothing is hidden and misleading the moment
  // something is, so the copy below says which set was searched instead of
  // reporting "no match" over a set the reader cannot see.
  const filterActive = query !== "" || effectiveBucket !== "all";
  const searchIsPartial = hiddenCount > 0 && filterActive;

  // Auto-switch when the ACTIVE thread would be filtered out (deep link
  // into an automation thread while the chip says Chat) — the selection
  // must always be visible in the list.
  useEffect(() => {
    if (!showFilters || bucket === "all") return;
    const active = threads.find((t) => t.id === activeThreadId);
    if (active && threadOriginBucket(active) !== bucket) {
      setBucket("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, threads, showFilters]);

  function selectBucket(next: ThreadOriginBucket) {
    setBucket(next);
    try {
      window.localStorage.setItem(BUCKET_STORAGE_KEY, next);
    } catch {
      // In-session only when storage is unavailable.
    }
  }

  async function createAndNavigate() {
    const thread = await createThread.mutateAsync();
    navigate({ search: (prev) => ({ ...prev, thread: thread.id, child: undefined }) });
    // Land the cursor in the composer — a fresh thread exists to be
    // typed into.
    useComposerPrefillStore.getState().requestFocus();
  }

  return (
    <>
      {/* `pr-12` reserves room for the AppShell's collapse toggle, which
          floats at the aside's top-right corner (absolute, so it doesn't
          contribute to the sidebar's intrinsic max-content width). */}
      <div className="pl-2 pr-12 pt-2">
        <button
          type="button"
          onClick={() => void createAndNavigate()}
          disabled={createThread.isPending}
          className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New thread</span>
        </button>
      </div>
      <div className="px-2 pt-1 pb-2 space-y-1.5">
        <div className="flex items-center gap-1.5 rounded border border-line bg-[--bg] px-2 focus-within:border-moss/60">
          <Search className="h-3.5 w-3.5 text-muted shrink-0" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads…"
            aria-label="Search threads"
            className="h-7 w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {showFilters && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Thread origin">
            {[THREAD_ORIGIN_FILTERS[0]!, ...bucketsInUse].map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={effectiveBucket === f.id}
                onClick={() => selectBucket(f.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-moss",
                  effectiveBucket === f.id
                    ? "bg-moss-wash-strong text-ink font-medium"
                    : "text-muted hover:text-ink hover:bg-ink-wash",
                )}
              >
                {f.label}
                {/* A "+" because the counts are over the loaded page, so a
                    capped list undercounts every bucket. */}
                <span className="tabular-nums text-[10px] opacity-70">
                  {counts[f.id]}
                  {hiddenCount > 0 && "+"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Plain overflow div, NOT the Radix ScrollArea — its viewport wraps
          content in a `display: table` div that sizes to intrinsic content
          width, which defeats both the sidebar's max-content sizing and
          row truncation when clamped. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <nav className="pb-3">
          {threadsQ.isLoading && (
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {threadsQ.error && (
            <div className="px-4 py-3 text-sm text-danger-500">Failed to load threads</div>
          )}
          {!threadsQ.isLoading && !threadsQ.error && visible.length === 0 && threads.length > 0 && (
            <div className="px-4 py-3 text-xs text-muted">
              No threads match{query ? ` "${query}"` : " this filter"}
              {searchIsPartial
                ? ` in the ${threads.length} threads loaded so far. Load the rest to search them.`
                : "."}
            </div>
          )}
          {visible.map((t) => (
            <ThreadNode
              key={t.id}
              thread={t}
              index={threads.indexOf(t)}
              active={t.id === activeThreadId}
              childSessions={grouped.get(t.id) ?? []}
              activeChildId={search.child}
              onArchive={(threadId) => {
                void setArchived.mutateAsync({ threadId, archived: true });
                // Archiving the thread you're looking at would strand the
                // view on a thread absent from the list — return to the
                // default thread.
                if (threadId === activeThreadId) {
                  navigate({ search: (prev) => ({ ...prev, thread: undefined, child: undefined }) });
                }
              }}
              onReplaceSandbox={() => void replaceSandbox.mutateAsync()}
              onDismissChild={(childSessionId) => void dismissChild.mutateAsync(childSessionId)}
            />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + THREAD_PAGE)}
              disabled={threadsQ.isFetching}
              className="mt-1 w-full rounded px-4 py-1.5 text-left text-xs text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50"
            >
              {filterActive ? "Search" : "Show"} {Math.min(hiddenCount, THREAD_PAGE)} more of {total} threads
            </button>
          )}
        </nav>
        <div className="border-t border-line/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="w-full flex items-center gap-2 rounded px-2 py-1 text-xs text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash"
          >
            <Archive className="h-3 w-3 shrink-0" aria-hidden />
            <span>{showArchived ? "Hide archived" : "Show archived"}</span>
          </button>
          {showArchived && (
            <ul className="mt-1 space-y-0.5">
              {(archivedQ.data?.threads ?? []).length === 0 && !archivedQ.isLoading && (
                <li className="px-2 py-1 text-xs text-muted">No archived threads.</li>
              )}
              {(archivedQ.data?.threads ?? []).map((t) => (
                <li key={t.id} className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
                  <span className="flex-1 truncate">{t.title ?? t.id}</span>
                  <button
                    type="button"
                    aria-label={`Unarchive ${t.title ?? t.id}`}
                    onClick={() => void setArchived.mutateAsync({ threadId: t.id, archived: false })}
                    className="shrink-0 rounded p-0.5 hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
                  >
                    <ArchiveRestore className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
              {archivedHidden > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setArchivedLimit((n) => n + THREAD_PAGE)}
                    disabled={archivedQ.isFetching}
                    className="w-full rounded px-2 py-1 text-left text-xs text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50"
                  >
                    Show {Math.min(archivedHidden, THREAD_PAGE)} more of {archivedTotal} archived threads
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function ThreadNode({
  thread,
  index,
  active,
  childSessions,
  activeChildId,
  onArchive,
  onReplaceSandbox,
  onDismissChild,
}: {
  thread: ThreadSummary;
  index: number;
  active: boolean;
  childSessions: OrchestratorChildSummary[];
  activeChildId?: string;
  onArchive: (threadId: string) => void;
  onReplaceSandbox: () => void;
  onDismissChild: (childSessionId: string) => void;
}) {
  const label = thread.title ?? untitledThreadLabel(thread, index);

  return (
    <div>
      {/* Row = link + context menu side by side; nesting the menu button
          inside the Link would make it part of the navigation target. */}
      <div
        className={cn(
          "group flex items-center pr-2 transition-colors",
          active
            ? "bg-moss-wash-strong border-l-2 border-moss"
            : "hover:bg-ink-wash/60 border-l-2 border-transparent",
        )}
      >
        <Tooltip content={label} delayDuration={600}>
          <Link
            to="/chat"
            search={(prev) => ({
              ...prev,
              thread: index === 0 ? undefined : thread.id,
              child: undefined,
            })}
            className={cn(
              // Left rail marks selection; `pl-[calc(1rem-2px)]` keeps the
              // title at the same x-offset whether or not the moss rail is
              // present — no shift when you click between threads.
              "flex-1 min-w-0 flex items-center py-2 text-sm",
              "focus-visible:outline-none focus-visible:bg-ink-wash",
              active ? "text-ink pl-[calc(1rem-2px)] font-medium" : "text-ink/85 pl-4",
            )}
          >
            <span className="flex-1 truncate">{label}</span>
          </Link>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Thread menu: ${label}`}
              className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onArchive(thread.id)}>
              <Archive className="h-3.5 w-3.5 mr-2" aria-hidden />
              Archive thread
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReplaceSandbox}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" aria-hidden />
              Replace sandbox (all threads)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {childSessions.length > 0 && (
        <ul className="ml-8 mt-0.5 mb-1 border-l border-line/60 pl-2 space-y-0.5">
          {childSessions.map((c) => (
            <li key={c.sessionId} className="group/child flex items-center gap-1">
              <Link
                to="/chat"
                search={(prev) => ({ ...prev, child: c.sessionId })}
                className={cn(
                  "flex-1 min-w-0 flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:bg-ink-wash",
                  // Settled children recede: their work is done and their
                  // compute reclaimed — visually distinct from live ones.
                  c.status === "settled" && "opacity-60",
                  c.sessionId === activeChildId
                    ? "bg-moss-wash-strong text-ink"
                    : "text-muted hover:bg-ink-wash/60 hover:text-ink",
                )}
              >
                <MessageSquare className="h-3 w-3 shrink-0" />
                <span className="flex-1 truncate">{c.title || c.sessionId}</span>
                {c.status === "settled" ? (
                  <span aria-label="settled" className="shrink-0 text-muted">
                    ✓
                  </span>
                ) : (
                  <span
                    aria-label="running"
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", childStatusDotClassName(c.status))}
                  />
                )}
              </Link>
              {c.status === "settled" && (
                <button
                  type="button"
                  aria-label={`Dismiss ${c.title || c.sessionId}`}
                  onClick={() => onDismissChild(c.sessionId)}
                  className="shrink-0 rounded p-0.5 text-muted opacity-0 group-hover/child:opacity-100 focus-visible:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Live-updates the children query (decision 12): refetch on any
 * `queue.state` frame for the assistant session, debounced so a burst of
 * frames only triggers one refetch. The 30s poll (`refetchInterval` on
 * `useOrchestratorChildren`) is the fallback for when no WS frames arrive.
 */
function useInvalidateChildrenOnQueueState(sessionId: string, refetch: () => void) {
  const queueByThread = useStreamStore((s) => s.bySession[sessionId]?.queueByThread);
  const debouncerRef = useRef<ReturnType<typeof createDebouncer> | null>(null);

  useEffect(() => {
    const debouncer = createDebouncer(refetch, CHILDREN_INVALIDATE_DEBOUNCE_MS);
    debouncerRef.current = debouncer;
    return () => debouncer.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!queueByThread) return;
    debouncerRef.current?.trigger();
  }, [queueByThread]);
}
