import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MessageSquare, Plus } from "lucide-react";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";
import { useCreateThread, useThreads } from "~/api/queries";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useStreamStore } from "~/stores/stream";
import { createDebouncer } from "~/lib/debounce";
import { ScrollArea, Spinner, Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";

const CHILDREN_POLL_MS = 30_000;
const CHILDREN_INVALIDATE_DEBOUNCE_MS = 500;

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
export function ThreadTree() {
  const info = useOrchestratorInfo();
  const sessionId = info.data?.sessionId;

  if (!sessionId) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted">
        <Spinner size={14} />
      </div>
    );
  }

  return <ThreadTreeInner sessionId={sessionId} />;
}

function ThreadTreeInner({ sessionId }: { sessionId: string }) {
  const threadsQ = useThreads(sessionId);
  const childrenQ = useOrchestratorChildren({ refetchInterval: CHILDREN_POLL_MS });
  useInvalidateChildrenOnQueueState(sessionId, childrenQ.refetch);
  const createThread = useCreateThread(sessionId);
  const navigate = useNavigate({ from: "/chat" });

  const search = (useSearch({ strict: false }) ?? {}) as { thread?: string; child?: string };
  const threads = threadsQ.data?.threads ?? [];
  const activeThreadId = search.thread ?? threads[0]?.id;
  const grouped = groupChildrenByThread(childrenQ.data?.children ?? []);

  async function createAndNavigate() {
    const thread = await createThread.mutateAsync();
    navigate({ search: (prev) => ({ ...prev, thread: thread.id, child: undefined }) });
  }

  return (
    <>
      <div className="px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={() => void createAndNavigate()}
          disabled={createThread.isPending}
          className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted hover:text-ink hover:bg-ink-wash transition-colors focus-visible:outline-none focus-visible:bg-ink-wash disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New thread</span>
        </button>
      </div>
      <ScrollArea className="flex-1">
        <nav className="pb-3">
          {threadsQ.isLoading && (
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {threadsQ.error && (
            <div className="px-4 py-3 text-sm text-danger-500">Failed to load threads</div>
          )}
          {threads.map((t, i) => (
            <ThreadNode
              key={t.id}
              thread={t}
              index={i}
              active={t.id === activeThreadId}
              childSessions={grouped.get(t.id) ?? []}
              activeChildId={search.child}
            />
          ))}
        </nav>
      </ScrollArea>
    </>
  );
}

function ThreadNode({
  thread,
  index,
  active,
  childSessions,
  activeChildId,
}: {
  thread: ThreadSummary;
  index: number;
  active: boolean;
  childSessions: OrchestratorChildSummary[];
  activeChildId?: string;
}) {
  const label = thread.title ?? (index === 0 ? "today" : `Thread ${index + 1}`);

  return (
    <div>
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
            "flex items-center pr-4 py-2 text-sm transition-colors",
            "focus-visible:outline-none focus-visible:bg-ink-wash",
            active
              ? "bg-moss/[0.08] text-ink border-l-2 border-moss pl-[calc(1rem-2px)] font-medium"
              : "text-ink/85 hover:bg-ink-wash/60 pl-4 border-l-2 border-transparent",
          )}
        >
          <span className="flex-1 truncate">{label}</span>
        </Link>
      </Tooltip>
      {childSessions.length > 0 && (
        <ul className="ml-8 mt-0.5 mb-1 border-l border-line/60 pl-2 space-y-0.5">
          {childSessions.map((c) => (
            <li key={c.sessionId}>
              <Link
                to="/chat"
                search={(prev) => ({ ...prev, child: c.sessionId })}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:bg-ink-wash",
                  c.sessionId === activeChildId
                    ? "bg-moss/[0.08] text-ink"
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
