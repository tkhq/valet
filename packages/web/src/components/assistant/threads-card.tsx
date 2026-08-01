import { Link } from "@tanstack/react-router";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";
import { Spinner } from "~/components/primitives";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useThreads } from "~/api/queries";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

const RECENT_LIMIT = 6;

export interface ThreadActivity {
  thread: ThreadSummary;
  running: number;
  settled: number;
}

/**
 * Pure: newest-first threads (capped) joined with their children's
 * running/settled counts — the "what's going on" summary the dashboard
 * card renders. Testable without queries.
 */
export function threadActivity(
  threads: ThreadSummary[],
  children: OrchestratorChildSummary[],
  limit = RECENT_LIMIT,
): ThreadActivity[] {
  const byThread = new Map<string, { running: number; settled: number }>();
  for (const c of children) {
    const entry = byThread.get(c.parentThreadId) ?? { running: 0, settled: 0 };
    if (c.status === "settled") entry.settled += 1;
    else entry.running += 1;
    byThread.set(c.parentThreadId, entry);
  }
  return [...threads]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((thread) => ({
      thread,
      running: byThread.get(thread.id)?.running ?? 0,
      settled: byThread.get(thread.id)?.settled ?? 0,
    }));
}

/**
 * Dashboard threads card — replaces the old single-pane chat log. The
 * orchestrator is threaded: several strands of work can be live at once,
 * so an interleaved message log reads as noise. This card answers "what's
 * going on": recent threads, newest first, each with its running/settled
 * child counts. Clicking a row opens that thread in /chat.
 */
export function ThreadsCard() {
  const info = useOrchestratorInfo();
  const sessionId = info.data?.sessionId;
  const name = info.data?.name ?? "your assistant";

  const threadsQ = useThreads(sessionId ?? "");
  const childrenQ = useOrchestratorChildren();
  const rows = threadActivity(threadsQ.data?.threads ?? [], childrenQ.data?.children ?? []);

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">
          <Link to="/chat" className="hover:text-moss">
            Threads
          </Link>
        </h2>
        <Link to="/chat" className="text-xs text-muted hover:text-moss">
          Open chat
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto max-h-64">
        {threadsQ.isLoading && (
          <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {threadsQ.error && (
          <div className="px-4 py-3 text-xs text-danger-500">
            Couldn't load threads.{" "}
            <button type="button" className="underline" onClick={() => threadsQ.refetch()}>
              Retry
            </button>
          </div>
        )}
        {!threadsQ.isLoading && !threadsQ.error && rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">
            No threads yet — open the chat and say hello to {name}.
          </p>
        )}
        <ul>
          {rows.map(({ thread, running, settled }) => (
            <li key={thread.id}>
              <Link
                to="/chat"
                search={{ thread: thread.id }}
                className="flex items-center gap-2.5 px-4 py-2 hover:bg-ink-wash/60 transition-colors"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    running > 0 ? "bg-moss animate-pulse motion-reduce:animate-none" : "bg-muted/40",
                  )}
                  aria-label={running > 0 ? `${running} running` : "idle"}
                />
                <span className="flex-1 truncate text-sm text-ink">
                  {thread.title || "Untitled thread"}
                </span>
                {running > 0 && (
                  <span className="shrink-0 text-[10px] font-medium text-moss">
                    {running} running
                  </span>
                )}
                {running === 0 && settled > 0 && (
                  <span className="shrink-0 text-[10px] text-muted">{settled} done</span>
                )}
                <span className="shrink-0 text-xs text-muted">{relativeTime(thread.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
