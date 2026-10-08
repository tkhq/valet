import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { bucketCounts, threadChannelType, threadOriginBucket, THREAD_ORIGIN_FILTERS, type ThreadOriginBucket } from "~/lib/thread-origin";
import { useChildWork, flattenChildWork, useDismissChild } from "~/api/child-work";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  Bot,
  Filter,
  Hash,
  Slack,
  Zap,
  Folder,
  FolderOpen,
  PanelLeft,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  DecisionGate,
  ChildWorkSummary,
  ThreadPullRequest,
  ThreadSummary,
} from "@valet/api/wire";
import {
  useArchivedThreads,
  useCreateThread,
  useRenameThread,
  useReplaceSandbox,
  useMarkThreadsRead,
  useSetThreadArchived,
  useSidebarThreads,
  useThreadSearch,
} from "~/api/queries";
import { isThreadUnread, pendingAgentQuestion, rowPullRequest } from "~/lib/thread-read";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useChatHotkeysStore } from "~/stores/chat-hotkeys";
import { useThreadProjects } from "~/lib/thread-projects";
import { useMe } from "~/api/settings";
import { usePendingGatesSeed } from "~/hooks/use-pending-gates-seed";
import { ThreadStatusIcon } from "./thread-status-icon";
import { useStreamStore, useThreadLiveStatus, useQueueStateForThread, queueBusy } from "~/stores/stream";
import { createDebouncer } from "~/lib/debounce";
import { formatChord } from "~/lib/chat-keybindings";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  StatusDot,
  Tooltip,
} from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";
import { cn } from "~/lib/cn";
import { getSubconversationsCollapsed, setSubconversationsCollapsed } from "~/lib/preferences";
import { defaultThreadId, isAppAssistantThread } from "~/lib/thread-default";

/** Creation order, not the current sidebar order, determines this label. */
export function untitledThreadLabel(thread: ThreadSummary, isNewestCreated: boolean): string {
  return isNewestCreated ? "New thread" : formatWhen(thread.createdAt);
}

const THREAD_DRAG_TYPE = "application/x-valet-thread";
const THREAD_SORT_STORAGE_KEY = "valet:thread-sort";
const THREAD_ORIGIN_STORAGE_KEY = "valet:thread-origin";

function loadStoredOriginFilter(): ThreadOriginBucket {
  try {
    const raw = window.localStorage.getItem(THREAD_ORIGIN_STORAGE_KEY);
    const match = THREAD_ORIGIN_FILTERS.find((candidate) => candidate.id === raw);
    if (match) return match.id;
  } catch {
    // Fall through.
  }
  return "all";
}

const PR_ICONS = {
  open: { Icon: GitPullRequest, label: "Pull request open", className: "text-emerald-600" },
  merged: { Icon: GitMerge, label: "Pull request merged", className: "text-violet-500" },
  closed: { Icon: GitPullRequestClosed, label: "Pull request closed", className: "text-muted" },
} as const;

/** The state of the pull request this thread created: open, merged, or closed. */
export function ThreadPullRequestIcon({ pr, count }: { pr: ThreadPullRequest; count: number }) {
  const { Icon, label, className } = PR_ICONS[pr.state];
  const text = `${label}: ${pr.repo}#${pr.number}${count > 1 ? ` (${count} pull requests)` : ""}`;
  return (
    <Tooltip content={text}>
      <span role="img" aria-label={text} className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon aria-hidden className={cn("h-3.5 w-3.5", className)} />
      </span>
    </Tooltip>
  );
}

/** Where a thread came from, as a small row icon: Slack, another channel,
 * web chat, an automation, or another agent. */
export function ThreadOriginIcon({ thread }: { thread: Pick<ThreadSummary, "key"> }) {
  const bucket = threadOriginBucket(thread);
  const channel = threadChannelType(thread);
  const [Icon, label] = bucket === "channel"
    ? channel === "slack" ? [Slack, "From Slack"] as const : [Hash, `From ${channel ?? "a channel"}`] as const
    : bucket === "auto" ? [Zap, "From an automation"] as const
    : bucket === "other" ? [Bot, "From another agent"] as const
    : [MessageSquare, "From web chat"] as const;
  return <Icon role="img" aria-label={label} className="mr-2 h-3.5 w-3.5 shrink-0 text-muted"><title>{label}</title></Icon>;
}

export const THREAD_SORT_MODES = [
  { id: "last-user-activity", label: "Last user activity" },
  { id: "created", label: "Created" },
] as const;

export type ThreadSortMode = (typeof THREAD_SORT_MODES)[number]["id"];

function loadStoredThreadSort(): ThreadSortMode {
  try {
    const raw = window.localStorage.getItem(THREAD_SORT_STORAGE_KEY);
    const mode = THREAD_SORT_MODES.find((candidate) => candidate.id === raw);
    if (mode) return mode.id;
  } catch {
    // Fall through.
  }
  return "last-user-activity";
}

/** Pure: orders active threads by the selected per-user preference. */
export function sortThreads(threads: ThreadSummary[], mode: ThreadSortMode): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    if (mode === "created") return b.createdAt - a.createdAt;
    return b.lastUserActivityAt - a.lastUserActivityAt || b.createdAt - a.createdAt;
  });
}

const CHILDREN_POLL_MS = 30_000;
const CHILDREN_INVALIDATE_DEBOUNCE_MS = 500;

/** Stable no-op so the live-update effect doesn't re-subscribe each render
 * when children are turned off. */
const NO_REFETCH = () => {};

/** Pure: groups children by the thread that spawned them. */
export function groupChildrenByThread(
  children: ChildWorkSummary[],
): Map<string, ChildWorkSummary[]> {
  const map = new Map<string, ChildWorkSummary[]>();
  for (const c of children) {
    const list = map.get(c.parentThreadId);
    if (list) list.push(c);
    else map.set(c.parentThreadId, [c]);
  }
  return map;
}

/**
 * Pure: the ids of threads that hold at least one pending gate. Feeds the
 * per-thread response-required bell (TKAI-258): the gate card and header badge are
 * scoped to the ACTIVE thread, so this bell is the only in-session surface
 * for a gate pending on a thread you are not looking at.
 */
export function threadIdsWithPendingGates(
  gates: Record<string, DecisionGate> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const g of Object.values(gates ?? {})) ids.add(g.threadId);
  return ids;
}

/**
 * Pure: true when a pending gate sits on a thread that is NOT in the
 * active-thread list — an archived thread. Marks the "Show archived"
 * toggle so the gate has a surface while the section is closed.
 */
export function hasGateOutsideList(
  threads: ThreadSummary[],
  gatedThreadIds: Set<string>,
): boolean {
  if (gatedThreadIds.size === 0) return false;
  const listed = new Set(threads.map((t) => t.id));
  for (const id of gatedThreadIds) {
    if (!listed.has(id)) return true;
  }
  return false;
}

/** Pure: status-dot class for a child row. Calm-companion visual language —
 * running is moss with a subtle pulse, settled is a muted checkmark. */
export function childStatusDotClassName(status: ChildWorkSummary["status"]): string {
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
  const info = useWorkspaceRuntimeInfo(override ? undefined : "user");
  // No `override` means the caller's own assistant — the original and still
  // the default behavior.
  const sessionId = override ?? info.data?.sessionId;

  if (!sessionId) return <ThreadTreeWaiting />;

  return <ThreadTreeInner key={sessionId} sessionId={sessionId} showChildren={showChildren} />;
}

/**
 * The tree's empty state: what stands in its place while the session it
 * would list is not yet known, or not yet created. The rail draws it for an
 * assistant whose session the page is still ensuring, so the tree's reads
 * do not run against a session that does not exist.
 */
export function ThreadTreeWaiting() {
  return (
    <div className="px-4 py-6 text-center text-xs text-muted">
      <Spinner size={14} />
    </div>
  );
}

export interface ThreadTreeProps {
  /** Whose threads to show. Defaults to the caller's own assistant. */
  sessionId?: string;
  /**
   * Nest child sessions under the thread that spawned them. Safe for any
   * assistant the caller can view: `GET /api/sessions/:sessionId/children`
   * scopes the list to THIS `sessionId` (access-checked), so a team
   * assistant's runs nest under its own threads rather than borrowing the
   * caller's personal children.
   */
  showChildren?: boolean;
}

function ThreadTreeInner({ sessionId, showChildren }: { sessionId: string; showChildren: boolean }) {
  const viewer = useMe();
  const projects = useThreadProjects(viewer.data?.id ?? "loading", sessionId);
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState<string>();
  function createProject() {
    const name = projectName.trim();
    if (!name) return;
    if (projects.value.projects.some((project) => project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setProjectError("A project with this name already exists.");
      return;
    }
    projects.update((current) => ({ ...current, grouped: true, collapsed: false, projects: [...current.projects, { id: crypto.randomUUID(), name, collapsed: false }] }));
    setProjectDialog(false);
    setProjectName("");
  }
  const search = (useSearch({ strict: false }) ?? {}) as { thread?: string; child?: string };
  const [sortMode, setSortMode] = useState<ThreadSortMode>(() => loadStoredThreadSort());
  const [originFilter, setOriginFilter] = useState<ThreadOriginBucket>(() => loadStoredOriginFilter());
  // Seed pending gates from REST for ourselves — the tree must not depend
  // on a SessionView being mounted for the same session. Live updates
  // arrive via the wire (`gate.*` frames); the record's identity only
  // changes when a gate opens or resolves, so the derived set is cheap.
  usePendingGatesSeed(sessionId);
  const pendingGates = useStreamStore((s) => s.bySession[sessionId]?.pendingGates);
  const gatedThreadIds = useMemo(() => threadIdsWithPendingGates(pendingGates), [pendingGates]);

  const fixedIds = [...new Set([...gatedThreadIds, ...projects.value.pinned, ...Object.keys(projects.value.assignments).filter(id =>
    projects.value.grouped && projects.value.projects.some(project => project.id === projects.value.assignments[id]))])].sort();
  const threadsQ = useSidebarThreads(sessionId, { sort: sortMode, origin: originFilter, fixedIds, threadId: search.thread });
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = moreRef.current;
    if (!target || !threadsQ.hasNextPage || threadsQ.isFetching || threadsQ.isError || typeof IntersectionObserver === "undefined") return;
    let requested = false;
    const observer = new IntersectionObserver(entries => {
      if (!requested && entries.some(entry => entry.isIntersecting)) {
        requested = true;
        void threadsQ.fetchNextPage();
      }
    }, { root: scrollRef.current });
    observer.observe(target);
    return () => observer.disconnect();
  }, [threadsQ.hasNextPage, threadsQ.isFetching, threadsQ.isError, threadsQ.fetchNextPage]);
  const markRead = useMarkThreadsRead(sessionId);
  const childrenQ = useChildWork(sessionId, {
    refetchInterval: CHILDREN_POLL_MS,
    enabled: showChildren,
  });
  // `refetch()` fires even on a disabled query, so gate the live-update
  // hook too rather than relying on `enabled` alone.
  useInvalidateChildrenOnQueueState(sessionId, showChildren ? childrenQ.refetch : NO_REFETCH);
  const createThread = useCreateThread(sessionId);
  const setArchived = useSetThreadArchived(sessionId);
  const renameThread = useRenameThread(sessionId);
  const replaceSandbox = useReplaceSandbox(sessionId);
  const dismissChild = useDismissChild(sessionId);
  const [showArchived, setShowArchived] = useState(false);
  const archivedQ = useArchivedThreads(sessionId, { enabled: showArchived });
  const navigate = useNavigate({ from: "/chat" });

  const threads = useMemo(
    () => sortThreads((threadsQ.data?.threads ?? []).filter((thread) => !isAppAssistantThread(thread)), sortMode),
    [threadsQ.data, sortMode],
  );
  // Both the sidebar and SessionView use this creation-order default. Sort only changes row order.
  const defaultId = threadsQ.data?.defaultThreadId ?? defaultThreadId(threads);
  const activeThreadId = search.thread ?? defaultId;
  const grouped = groupChildrenByThread(showChildren ? (childrenQ.error ? [] : flattenChildWork(childrenQ.data)) : []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelectedId, setSearchSelectedId] = useState<string>();
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const debouncedSearch = useDebouncedValue(normalizedSearch, 250);
  const matchingProjects = projects.value.projects.filter(project => project.name.toLowerCase().includes(debouncedSearch));
  const projectSearchIds = Object.keys(projects.value.assignments).filter(id => matchingProjects.some(project => project.id === projects.value.assignments[id]));
  const contentSearch = useThreadSearch(sessionId, debouncedSearch, searchOpen, projectSearchIds);
  const contentMatchIds = new Set(
    debouncedSearch === normalizedSearch ? contentSearch.data?.threads.map((thread) => thread.id) : [],
  );
  const searching = !!normalizedSearch && (debouncedSearch !== normalizedSearch || contentSearch.isFetching);
  const searchCandidates = [...new Map([...threads, ...(debouncedSearch === normalizedSearch ? contentSearch.data?.threads ?? [] : [])].map(thread => [thread.id, thread])).values()];
  const searchResults = sortThreads(searchCandidates.filter(thread => !isAppAssistantThread(thread)), sortMode).filter((thread) => {
    const project = projects.value.projects.find((p) => p.id === projects.value.assignments[thread.id]);
    return contentMatchIds.has(thread.id) || `${thread.title ?? ""} ${project?.name ?? ""}`.toLowerCase().includes(normalizedSearch);
  });
  const searchIndex = Math.max(0, searchResults.findIndex((thread) => thread.id === searchSelectedId));
  function openSearch() { setSearchQuery(""); setSearchSelectedId(undefined); setSearchOpen(true); }
  function selectSearchThread(threadId: string) {
    setSearchOpen(false);
    navigate({ search: (prev) => ({ ...prev, thread: threadId, child: undefined }) });
  }
  const originCounts = threadsQ.data?.originCounts ?? bucketCounts(threads);
  const visible = originFilter === "all" ? threads : threads.filter((thread) => threadOriginBucket(thread) === originFilter);
  function selectOriginFilter(next: ThreadOriginBucket) {
    setOriginFilter(next);
    try {
      window.localStorage.setItem(THREAD_ORIGIN_STORAGE_KEY, next);
    } catch {
      // In-session only when storage is unavailable.
    }
  }
  // A gate on an archived thread has no row in `visible`; without this the
  // gate would be invisible while the archived section is closed.
  const archivedGated = threadsQ.data !== undefined && threadsQ.fixedReady && hasGateOutsideList(threadsQ.data?.threads ?? [], gatedThreadIds);

  function selectThreadSort(next: ThreadSortMode) {
    setSortMode(next);
    try {
      window.localStorage.setItem(THREAD_SORT_STORAGE_KEY, next);
    } catch {
      // In-session only when storage is unavailable.
    }
  }

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [creationError, setCreationError] = useState<string>();
  const currentSession = useRef<string | undefined>(sessionId);
  useEffect(() => {
    currentSession.current = sessionId;
    return () => { currentSession.current = undefined; };
  }, [sessionId]);

  async function createAndNavigate(projectId?: string) {
    setCreationError(undefined);
    try {
      // A new thread uses the workspace defaults, not the active thread's settings.
      const thread = await createThread.mutateAsync();
      if (projectId) moveThread(thread.id, projectId);
      // A workspace switch during creation must not open the old workspace's thread.
      if (currentSession.current !== sessionId) return;
      navigate({ search: (prev) => ({ ...prev, thread: thread.id, child: undefined }) });
      useComposerPrefillStore.getState().requestFocus();
    } catch {
      if (currentSession.current === sessionId) setCreationError("Could not create the thread. Try again.");
    }
  }

  const archiveActive = useCallback(() => {
    if (!activeThreadId || isAppAssistantThread(threadsQ.data?.threads.find((thread) => thread.id === activeThreadId) ?? {})) return;
    void setArchived.mutateAsync({ threadId: activeThreadId, archived: true });
    navigate({ search: (prev) => ({ ...prev, thread: undefined, child: undefined }) });
  }, [activeThreadId, navigate, setArchived, threadsQ.data]);

  // Register this surface's hotkey targets for the global listener.
  useEffect(() => {
    return useChatHotkeysStore.getState().register({
      newThread: () => void createAndNavigate(),
      archiveActiveThread: archiveActive,
      focusThreadSearch: openSearch,
    });
    // createAndNavigate closes over createThread/navigate; re-register when
    // those identities change so the hotkey never calls a stale mutator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveActive, createThread, navigate]);

  const [dropTarget, setDropTarget] = useState<string>();
  function moveThread(threadId: string, projectId?: string) {
    projects.update((current) => {
      const assignments = { ...current.assignments };
      if (projectId) assignments[threadId] = projectId;
      else delete assignments[threadId];
      return { ...current, assignments, projects: current.projects.map((project) => project.id === projectId ? { ...project, collapsed: false } : project) };
    });
  }
  function dropHandlers(projectId?: string) {
    const target = projectId ?? "recents";
    return {
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(target);
      },
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropTarget(undefined);
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
        event.preventDefault();
        setDropTarget(undefined);
        try {
          const data: unknown = JSON.parse(event.dataTransfer.getData(THREAD_DRAG_TYPE));
          if (!data || typeof data !== "object" || !("sessionId" in data) || data.sessionId !== sessionId || !("threadId" in data) || typeof data.threadId !== "string") return;
          if (!threads.some((thread) => thread.id === data.threadId)) return;
          moveThread(data.threadId, projectId);
        } catch { /* Ignore unrelated or malformed drag data. */ }
      },
    };
  }

  const renderThread = (t: ThreadSummary) => (
            <ThreadNode
              key={t.id}
              thread={t}
              isDefault={t.id === defaultId}
              active={t.id === activeThreadId}
              hasPendingGate={gatedThreadIds.has(t.id)}
              childSessions={grouped.get(t.id) ?? []}
              activeChildId={search.child}
              projects={projects.value.projects}
              projectId={projects.value.assignments[t.id]}
              pinned={projects.value.pinned.includes(t.id)}
              onPin={() => projects.update((current) => ({ ...current, pinned: current.pinned.includes(t.id) ? current.pinned.filter((id) => id !== t.id) : [...current.pinned, t.id] }))}
              onMove={(projectId) => moveThread(t.id, projectId)}
              onDragEnd={() => setDropTarget(undefined)}
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
              onRename={(threadId, title) =>
                void renameThread.mutateAsync({ threadId, title })
              }
            />

  );

  return (
    <>
      {/* Match the search field below (`px-2`). The collapse toggle no
          longer floats over the sidebar — it now sits in the top nav
          (see `SidebarControls` in `app-shell.tsx`), so there is nothing
          left to reserve room for at the aside's top-right corner. */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <button
          type="button"
          onClick={() => void createAndNavigate()}
          disabled={createThread.isPending}
          className="flex-1 flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New thread</span>
        </button>
        <button type="button" aria-label="Search threads" title="Search threads" onClick={openSearch} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink"><Search className="h-4 w-4" /></button>
      </div>
      {creationError && <p role="alert" className="px-4 py-2 text-xs text-danger-500">{creationError}</p>}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent hideClose className="max-w-2xl rounded-2xl p-2 gap-1" onOpenAutoFocus={(event) => { event.preventDefault(); searchInputRef.current?.focus(); }}>
          <DialogTitle className="sr-only">Search threads</DialogTitle>
          <input ref={searchInputRef} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchSelectedId(undefined); }}
            placeholder="Search names and chat content" aria-label="Search threads" maxLength={500} role="combobox" aria-expanded aria-controls="thread-search-results" aria-activedescendant={searchResults[searchIndex] ? `thread-search-${searchResults[searchIndex]!.id}` : undefined}
            className="w-full bg-transparent px-4 py-4 text-lg outline-none placeholder:text-muted"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = Math.max(0, Math.min(searchResults.length - 1, searchIndex + (event.key === "ArrowDown" ? 1 : -1)));
                setSearchSelectedId(searchResults[next]?.id);
                document.getElementById(`thread-search-${searchResults[next]?.id}`)?.scrollIntoView({ block: "nearest" });
              }
              if (event.key === "Enter" && searchResults[searchIndex]) { event.preventDefault(); selectSearchThread(searchResults[searchIndex]!.id); }
            }} />
          <p className="px-4 pt-2 pb-1 text-xs text-muted">{searchQuery ? "Threads" : "Recent threads"}</p>
          <div id="thread-search-results" role="listbox" aria-label="Threads" className="max-h-[45dvh] overflow-y-auto">
            {searchResults.map((thread, index) => {
              const project = projects.value.projects.find((p) => p.id === projects.value.assignments[thread.id]);
              return <button key={thread.id} id={`thread-search-${thread.id}`} type="button" role="option" aria-selected={index === searchIndex}
                onMouseMove={() => setSearchSelectedId(thread.id)} onClick={() => selectSearchThread(thread.id)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-sm", index === searchIndex && "bg-ink-wash")}>
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">{gatedThreadIds.has(thread.id) && <Bell className="h-4 w-4 text-amber-500" />}</span>
                <span className="min-w-0 flex-1 truncate">{thread.title || untitledThreadLabel(thread, thread.id === defaultId)}</span>
                {project && <span className="max-w-[30%] truncate text-muted">{project.name}</span>}
              </button>;
            })}
            {searching && <p role="status" className="px-4 py-2 text-sm text-muted">Searching chat content…</p>}
            {normalizedSearch && contentSearch.isError && <p role="alert" className="px-4 py-2 text-sm text-muted">Could not search chat content. <button type="button" onClick={() => void contentSearch.refetch()} className="underline">Try again</button></p>}
            {searchResults.length === 0 && !searching && !contentSearch.isError && <p className="px-4 py-6 text-sm text-muted">No matching threads in this workspace.</p>}
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <button type="button" disabled={createThread.isPending} onClick={() => { setSearchOpen(false); void createAndNavigate(); }} className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm hover:bg-ink-wash"><Plus className="h-5 w-5" />New thread</button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Plain overflow div, NOT the Radix ScrollArea — its viewport wraps
          content in a `display: table` div that sizes to intrinsic content
          width, which defeats row truncation within the fixed-width sidebar. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <nav className="pb-3">
          <div className="flex items-center gap-1 px-3 py-2">
            <button onClick={() => projects.update((current) => ({ ...current, collapsed: !current.collapsed }))} aria-expanded={!projects.value.collapsed} className="flex flex-1 items-center gap-1 text-sm text-muted hover:text-ink">Projects {threads.some((thread) => gatedThreadIds.has(thread.id) && projects.value.assignments[thread.id]) && <Bell aria-label="Project threads need approval" className="h-3.5 w-3.5 text-amber-500" />} <ChevronDown className={cn("h-3.5 w-3.5", projects.value.collapsed && "-rotate-90")} /></button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button aria-label="Sidebar options" className="rounded p-1 text-muted hover:bg-ink-wash hover:text-ink"><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger><PanelLeft className="h-4 w-4" />Organize sidebar</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {[{ label: "By project", grouped: true }, { label: "In one list", grouped: false }].map((option) => <DropdownMenuItem key={option.label} role="menuitemradio" aria-checked={projects.value.grouped === option.grouped} onSelect={() => projects.update((current) => ({ ...current, grouped: option.grouped }))}><Check className={cn("h-4 w-4", projects.value.grouped !== option.grouped && "invisible")} />{option.label}</DropdownMenuItem>)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger><Filter className="h-4 w-4" />Show threads from</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>{THREAD_ORIGIN_FILTERS.map((option) => <DropdownMenuItem key={option.id} role="menuitemradio" aria-checked={originFilter === option.id} onSelect={() => selectOriginFilter(option.id)}><Check className={cn("h-4 w-4", originFilter !== option.id && "invisible")} /><span className="flex-1">{option.label}</span><span className="text-xs text-muted">{originCounts[option.id]}</span></DropdownMenuItem>)}</DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem disabled={!threads.some((thread) => isThreadUnread(thread))} onSelect={() => markRead.mutate({})}><CheckCheck className="h-4 w-4" />Mark all as read</DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger><ArrowDownUp className="h-4 w-4" />Sort chats by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>{THREAD_SORT_MODES.map((mode) => <DropdownMenuItem key={mode.id} role="menuitemradio" aria-checked={sortMode === mode.id} onSelect={() => selectThreadSort(mode.id)}><Check className={cn("h-4 w-4", sortMode !== mode.id && "invisible")} />{mode.label}</DropdownMenuItem>)}</DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            <button aria-label="New project" disabled={!viewer.data?.id} onClick={() => { setProjectError(undefined); setProjectName(""); setProjectDialog(true); }} className="rounded p-1 text-muted hover:bg-ink-wash hover:text-ink"><Plus className="h-4 w-4" /></button>
          </div>
          {originFilter !== "all" && (
            <p className="flex items-center gap-2 px-4 pb-1 text-xs text-muted">
              Showing {THREAD_ORIGIN_FILTERS.find((option) => option.id === originFilter)?.label.toLowerCase()}
              <button type="button" className="underline hover:text-ink" onClick={() => selectOriginFilter("all")}>Clear</button>
            </p>
          )}
          <Dialog open={projectDialog} onOpenChange={setProjectDialog}>
            <DialogContent title="New project">
              <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); createProject(); }}>
                <label className="grid gap-2 text-sm">Project name<Input autoFocus value={projectName} onChange={(event) => { setProjectName(event.target.value); setProjectError(undefined); }} placeholder="e.g. turnkey" maxLength={100} /></label>
                {projectError && <p role="alert" className="text-xs text-danger-500">{projectError}</p>}
                <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setProjectDialog(false)}>Cancel</Button><Button type="submit" disabled={!projectName.trim()}>Create project</Button></div>
              </form>
            </DialogContent>
          </Dialog>

          {threadsQ.isLoading && (
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {threadsQ.fixedError && (
            <div role="alert" className="px-4 py-3 text-sm text-danger-500">Could not load pinned, project, or selected threads. {threadsQ.fixedError.message} <button type="button" onClick={() => void threadsQ.refetchFixed()} className="underline">Retry</button></div>
          )}
          {threadsQ.error && (
            <div role="alert" className="px-4 py-3 text-sm text-danger-500">Could not load threads. <button type="button" onClick={() => void (threadsQ.isFetchNextPageError ? threadsQ.fetchNextPage() : threadsQ.refetch())} className="underline">Retry</button></div>
          )}
          {visible.some((thread) => projects.value.pinned.includes(thread.id)) && <section aria-label="Pinned"><h2 className="px-4 pb-1 pt-3 text-xs font-medium text-muted">Pinned</h2>{visible.filter((thread) => projects.value.pinned.includes(thread.id)).map(renderThread)}</section>}
          {projects.value.grouped && !projects.value.collapsed && projects.value.projects.map((project) => {
            const members = visible.filter((thread) => !projects.value.pinned.includes(thread.id) && projects.value.assignments[thread.id] === project.id);
            return <section key={project.id} aria-label={`Project: ${project.name}`} {...dropHandlers(project.id)} className={cn("mb-1 rounded-lg transition-colors", dropTarget === project.id && "bg-moss-wash-strong ring-1 ring-inset ring-moss")}>
              <div className="flex items-center pr-2">
              <button type="button" aria-expanded={!project.collapsed} onClick={() => projects.update((current) => ({ ...current, projects: current.projects.map((item) => item.id === project.id ? { ...item, collapsed: !item.collapsed } : item) }))} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-4 py-2 text-left text-sm text-ink hover:bg-ink-wash">
                {project.collapsed ? <Folder className="h-4 w-4 shrink-0" /> : <FolderOpen className="h-4 w-4 shrink-0" />}
                <span className="truncate">{project.name}</span>{members.some((thread) => gatedThreadIds.has(thread.id)) && <Bell aria-label="Needs approval" className="ml-auto h-3.5 w-3.5 shrink-0 text-amber-500" />}
              </button>
                <button type="button" aria-label={`New thread in ${project.name}`} title={`New thread in ${project.name}`} disabled={createThread.isPending}
                  onClick={() => void createAndNavigate(project.id)}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss disabled:opacity-50 sm:h-8 sm:w-8">
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {!project.collapsed && <div className="ml-4 border-l border-line/50">{members.map(renderThread)}{members.length === 0 && <p className="px-4 py-2 text-xs text-muted">Start a thread with + or move one here</p>}</div>}
            </section>;
          })}
          <section aria-label="Recents" {...dropHandlers()} className={cn("min-h-16 rounded-lg transition-colors", dropTarget === "recents" && "bg-moss-wash-strong ring-1 ring-inset ring-moss")}><h2 className="px-4 pb-1 pt-4 text-xs font-medium text-muted">Recents</h2>
          {visible.filter((thread) => !projects.value.pinned.includes(thread.id) && (!projects.value.grouped || !projects.value.projects.some((project) => project.id === projects.value.assignments[thread.id]))).map(renderThread)}
          </section>
          {threadsQ.hasNextPage && <button ref={moreRef} type="button" disabled={threadsQ.isFetching} onClick={() => void threadsQ.fetchNextPage()} className="px-4 py-2 text-xs text-moss">{threadsQ.isFetchingNextPage ? "Loading threads…" : "Load more threads"}</button>}
        </nav>
        {showChildren && childrenQ.isLoading && <p className="px-4 py-2 text-xs text-muted">Loading work…</p>}
        {showChildren && childrenQ.error && <p className="px-4 py-2 text-xs text-danger-500">Could not load work. <button onClick={() => void childrenQ.refetch()} className="underline">Retry</button></p>}
        {showChildren && !childrenQ.error && childrenQ.hasNextPage && <button className="px-4 py-2 text-xs text-moss" disabled={childrenQ.isFetchingNextPage} onClick={() => void childrenQ.fetchNextPage()}>{childrenQ.isFetchingNextPage ? "Loading…" : "Load more work"}</button>}
        <div className="border-t border-line/60 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="w-full max-md:min-h-11 flex items-center gap-2 rounded px-2 py-1 text-xs text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash"
          >
            <Archive className="h-3 w-3 shrink-0" aria-hidden />
            <span>{showArchived ? "Hide archived" : "Show archived"}</span>
            {archivedGated && (
              <span role="img" aria-label="Response required" title="Response required">
                <Bell className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
              </span>
            )}
          </button>
          {showArchived && (
            <ul className="mt-1 space-y-0.5">
              {(archivedQ.data?.threads ?? []).filter((thread) => !isAppAssistantThread(thread)).length === 0 && !archivedQ.isLoading && (
                <li className="px-2 py-1 text-xs text-muted">No archived threads.</li>
              )}
              {(archivedQ.data?.threads ?? []).filter((thread) => !isAppAssistantThread(thread)).map((t) => (
                <li key={t.id} className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
                  <span className="flex-1 truncate">{t.title ?? t.id}</span>
                  {gatedThreadIds.has(t.id) && (
                    <span role="img" aria-label="Response required" title="Response required">
                      <Bell className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Unarchive ${t.title ?? t.id}`}
                    onClick={() => void setArchived.mutateAsync({ threadId: t.id, archived: false })}
                    className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-0.5 hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
                  >
                    <ArchiveRestore className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function ThreadNode({
  thread,
  isDefault,
  active,
  hasPendingGate,
  childSessions,
  activeChildId,
  onArchive,
  onReplaceSandbox,
  onDismissChild,
  onRename,
  projects,
  projectId,
  onMove,
  onDragEnd,
  pinned,
  onPin,
}: {
  pinned: boolean;
  onPin: () => void;
  projects: Array<{ id: string; name: string }>;
  projectId?: string;
  onMove: (projectId?: string) => void;
  onDragEnd: () => void;
  thread: ThreadSummary;
  isDefault: boolean;
  active: boolean;
  /** The thread holds a pending decision gate — show the response-required bell. */
  hasPendingGate: boolean;
  childSessions: ChildWorkSummary[];
  activeChildId?: string;
  onArchive: (threadId: string) => void;
  onReplaceSandbox: () => void;
  onDismissChild: (childSessionId: string) => void;
  /** Send `null` to clear the stored title. */
  onRename: (threadId: string, title: string | null) => void;
}) {
  const label = thread.title ?? untitledThreadLabel(thread, isDefault);
  const liveStatus = useThreadLiveStatus(thread.sessionId, thread.id);
  const markRead = useMarkThreadsRead(thread.sessionId);
  // An open thread is read: mark it when it opens and when a new reply lands.
  const unread = !active && isThreadUnread(thread);
  const openUnread = active && isThreadUnread(thread);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (openUnread) markReadMutate({ threadIds: [thread.id] });
  }, [openUnread, markReadMutate, thread.id, thread.lastAgentActivityAt]);
  const pullRequest = rowPullRequest(thread.pullRequests);
  // A question waiting on a reply outranks plain unread: it asks for an answer.
  const question = pendingAgentQuestion(thread);
  const queueState = useQueueStateForThread(thread.sessionId, thread.id);
  const [collapsed, setCollapsed] = useState(() => getSubconversationsCollapsed(thread.id));

  useEffect(() => {
    setCollapsed(getSubconversationsCollapsed(thread.id));
  }, [thread.id]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    setSubconversationsCollapsed(thread.id, next);
  }

  // Port the v1 inline editor. Enter and blur save. Escape cancels.
  // `savedRef` prevents Enter and its following blur from saving twice.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const startEditing = () => {
    setDraft(thread.title ?? "");
    savedRef.current = false;
    setIsEditing(true);
  };

  const commit = () => {
    if (savedRef.current) return;
    savedRef.current = true;
    const trimmed = draft.trim();
    const currentTitle = thread.title?.trim() ?? "";
    if (trimmed !== currentTitle) {
      onRename(thread.id, trimmed.length === 0 ? null : trimmed);
    }
    setIsEditing(false);
  };

  const cancel = () => {
    savedRef.current = true;
    setIsEditing(false);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  // The menu-scoped `A`, plus the global chord shown beside it as a hint.
  const archiveGlobalHint = formatChord({ shift: true, code: "Backspace", key: "Backspace" });

  const handleMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // A bare `A` only. Without this, Select All (⌘A / Ctrl+A) pressed
      // while the menu happens to be open archives the thread.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "A" || e.key === "a") {
        e.preventDefault();
        onArchive(thread.id);
        setMenuOpen(false);
      }
    },
    [onArchive, thread.id],
  );

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
        {isEditing ? (
          <div className={cn("flex-1 min-w-0 py-1", active ? "pl-[calc(1rem-2px)]" : "pl-4")}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
              onBlur={commit}
              maxLength={200}
              aria-label={`Rename thread: ${label}`}
              placeholder="Thread name"
              className={cn(
                "w-full rounded border border-line bg-surface px-1.5 py-0.5 text-sm text-ink",
                "outline-none focus:ring-1 focus:ring-moss",
              )}
            />
          </div>
        ) : (
          <Tooltip content={label} delayDuration={600}>
            <Link
              to="/chat"
              search={(prev) => ({
                ...prev,
                thread: isDefault ? undefined : thread.id,
                child: undefined,
              })}
              className={cn(
                "flex-1 min-w-0 max-md:min-h-11 flex items-center py-2 text-sm",
                "focus-visible:outline-none focus-visible:bg-ink-wash",
                active ? "text-ink pl-[calc(1rem-2px)] font-medium" : "text-ink/85 pl-4",
              )}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify({ sessionId: thread.sessionId, threadId: thread.id }));
              }}
              onDragEnd={onDragEnd}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEditing();
              }}
            >
              <ThreadOriginIcon thread={thread} />
              <span className={cn("flex-1 truncate", unread && "font-medium text-ink")}>{label}</span>
              {pullRequest && <ThreadPullRequestIcon pr={pullRequest} count={thread.pullRequests?.length ?? 0} />}
              {question
                ? <Tooltip content={`Valet asks: ${question}`}><span className="mx-1.5 inline-flex"><StatusDot tone="warning" label="Valet asked you a question" /></span></Tooltip>
                : unread && <StatusDot tone="info" label="Unread" className="mx-1.5" />}
              <ThreadStatusIcon status={liveStatus.status} busy={queueBusy(queueState)} needsApproval={hasPendingGate} />

            </Link>
          </Tooltip>
        )}
        {childSessions.length > 0 && (
          <button
            type="button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} subconversations for ${label}`}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
            className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-1 text-muted hover:text-ink hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
              aria-hidden
            />
          </button>
        )}
        <Tooltip content={pinned ? "Unpin thread" : "Pin thread"}><button type="button" aria-label={pinned ? "Unpin thread" : "Pin thread"} onClick={onPin} className="inline-flex shrink-0 items-center justify-center rounded p-1 text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 hover:bg-ink-wash hover:text-ink">{pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</button></Tooltip>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Thread menu: ${label}`}
              className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-1 text-muted opacity-0 max-md:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onKeyDown={handleMenuKeyDown}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Folder className="h-4 w-4" />Move to project</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => onMove()}><Check className={cn("h-4 w-4", !!projectId && "invisible")} />Recents</DropdownMenuItem>
                {projects.length > 0 && <DropdownMenuSeparator />}
                {projects.map((project) => <DropdownMenuItem key={project.id} onSelect={() => onMove(project.id)}><Check className={cn("h-4 w-4", projectId !== project.id && "invisible")} />{project.name}</DropdownMenuItem>)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              onSelect={() => onArchive(thread.id)}
              className="justify-between gap-3"
            >
              <span className="inline-flex items-center gap-2">
                <Archive className="h-4 w-4" aria-hidden />
                Archive thread
              </span>
              <span className="text-[10px] text-muted tabular-nums" title={archiveGlobalHint}>
                A
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startEditing()}>
              <Pencil className="h-4 w-4" aria-hidden />
              Rename thread
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReplaceSandbox}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Replace sandbox (all threads)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {childSessions.length > 0 && !collapsed && (
        <ul className="ml-8 mt-0.5 mb-1 border-l border-line/60 pl-2 space-y-0.5">
          {childSessions.map((c) => (
            <li key={c.sessionId} className="group/child flex items-center gap-1">
              <Link
                to="/chat"
                search={(prev) => ({ ...prev, child: c.sessionId })}
                className={cn(
                  "flex-1 min-w-0 max-md:min-h-11 flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
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
                  <span role="img" aria-label="settled" className="shrink-0 text-muted">
                    ✓
                  </span>
                ) : (
                  <span
                    role="img"
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
                  className="inline-flex items-center justify-center max-md:min-h-11 max-md:min-w-11 shrink-0 rounded p-0.5 text-muted opacity-0 max-md:opacity-100 group-hover/child:opacity-100 focus-visible:opacity-100 hover:text-ink hover:bg-ink-wash focus-visible:outline-none"
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
 * `useChildWork`) is the fallback for when no WS frames arrive.
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
