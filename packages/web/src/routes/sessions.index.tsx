import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { SessionRunState, SessionSummary } from "@valet/api/wire";
import { useSessions } from "~/api/queries";
import { useListOwner } from "~/lib/use-list-owner";
import { Button, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { NewSessionDialog } from "~/components/new-session-dialog";
import {
  WorkspaceClause,
  useActiveWorkspace,
  workspaceName,
  type ActiveWorkspace,
} from "~/components/workspace-clause";
import { RunStateBadge } from "~/components/run-state-badge";
import { relativeTime } from "~/lib/relative-time";

/**
 * `/sessions` — the standalone-only list (decision 1/8). Filtering happens
 * server-side in `GET /api/sessions` (excludes orchestrator ids and any id
 * present in `child_watches.child_session_id`) — this route just renders
 * what it gets. Hosts the "Sessions" nav link and the "New session" action
 * (moved out of the top nav per decision 9/assistant-first IA).
 *
 * The query polls itself while work is in flight (see `useSessions`), so a
 * row's state and its age stay true on a page nobody is touching.
 */
export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

/**
 * How far up the list each run state pulls a row.
 *
 * `needs_you` leads because nothing moves until a person answers. `failed`
 * is second for the same reason — the turn stopped, and only a person
 * restarts it. `working` follows: it advances on its own, so it is news,
 * not a task. `idle` and `sleeping` share the last rank because neither
 * asks for anything; recency alone separates them.
 */
const ATTENTION_RANK: Record<SessionRunState, number> = {
  needs_you: 0,
  failed: 1,
  working: 2,
  idle: 3,
  sleeping: 3,
};

/**
 * Sorts the rows that need a person to the top, then orders each rank by
 * most recent activity. Pure and exported so the order is testable without
 * a render. It copies before it sorts — the array belongs to the query
 * cache, and `Array.prototype.sort` mutates in place.
 */
export function sortByAttention(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const byRank = ATTENTION_RANK[a.runState] - ATTENTION_RANK[b.runState];
    if (byRank !== 0) return byRank;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/** The empty state names the workspace it is empty IN — an empty team list
 * otherwise reads as the switcher not working, which is exactly the report
 * that motivated the workspace clause. */
function emptyLabel(ws: ActiveWorkspace | undefined): string {
  if (ws !== undefined && (ws.kind === "team" || ws.hasTeams)) {
    return `No sessions in ${workspaceName(ws)} yet.`;
  }
  return "No standalone sessions.";
}

export function SessionsPage() {
  const [newOpen, setNewOpen] = useState(false);
  // Scoped by the nav's workspace switcher, like every other list.
  const owner = useListOwner();
  const ws = useActiveWorkspace();
  const { data, isLoading, error, refetch } = useSessions(owner);
  // Design sessions are a different kind of session with their own home
  // (/design); listing them here would give them two homes and the wrong
  // default click-through (the code session page, not the canvas).
  const sessions = sortByAttention((data?.sessions ?? []).filter((s) => s.kind !== "design"));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sessions</h1>
          <WorkspaceClause />
        </div>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          <span>New session</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && <LoadingRow label="Loading sessions…" className="py-0" />}
        {!isLoading && error && (
          <ErrorRow className="flex items-center gap-3 py-0">
            <span>The sessions did not load. Select Retry.</span>
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          </ErrorRow>
        )}
        {!isLoading && !error && sessions.length === 0 && (
          <EmptyRow className="py-0">
            {emptyLabel(ws)} A standalone session is for direct work and automation. Select{" "}
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className="text-ink underline underline-offset-2 hover:text-moss"
            >
              New session
            </button>{" "}
            to start one.
          </EmptyRow>
        )}
        {!isLoading && sessions.length > 0 && (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
        )}
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

/**
 * One row, read left to right: what it is, what it is doing, and how long
 * it has been doing it. The workspace label stays as the second line — it
 * is the only thing that tells two same-named sessions apart.
 */
function SessionRow({ session }: { session: SessionSummary }) {
  return (
    <li>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        className="flex flex-col gap-1 rounded border border-line bg-paper px-4 py-3 hover:bg-ink-wash"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {session.title || "Untitled session"}
          </span>
          <RunStateBadge state={session.runState} className="shrink-0" />
        </div>
        <div className="flex items-baseline gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate font-mono">{session.workspace}</span>
          <span className="shrink-0">{relativeTime(session.lastActivityAt)}</span>
        </div>
      </Link>
    </li>
  );
}
