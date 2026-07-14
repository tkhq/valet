import { Link } from "@tanstack/react-router";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useSessions } from "~/api/queries";
import { Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

const RECENT_LIMIT = 5;

/**
 * Pure: derives the "N tasks running under today's thread" line from
 * `activeChildren`, or `null` when there's nothing running (component
 * hides the line entirely). Children themselves are never listed flat
 * here — decision 15: they live in the chat's thread tree, not this card.
 */
export function activeChildrenLine(activeChildren: number): string | null {
  if (activeChildren <= 0) return null;
  return `${activeChildren} task${activeChildren === 1 ? "" : "s"} running under today's thread`;
}

/**
 * Dashboard "your work" card: recent standalone sessions (already
 * server-filtered to standalone-only by `GET /sessions`, decision 8 — this
 * component does no filtering of its own, just sorts/slices what it
 * receives) plus the active-children count line.
 */
export function WorkCard() {
  const sessionsQ = useSessions();
  const info = useOrchestratorInfo();

  const sessions = (sessionsQ.data?.sessions ?? [])
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT);
  const childrenLine = activeChildrenLine(info.data?.activeChildren ?? 0);

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">Your work</h2>
        <Link to="/sessions" className="text-xs text-muted hover:text-moss">
          View all
        </Link>
      </header>

      <div className="flex-1 px-4 py-3 space-y-3 overflow-y-auto max-h-64">
        {sessionsQ.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {sessionsQ.error && (
          <div className="text-xs text-danger-500">
            Couldn't load sessions.{" "}
            <button type="button" className="underline" onClick={() => sessionsQ.refetch()}>
              Retry
            </button>
          </div>
        )}
        {!sessionsQ.isLoading && !sessionsQ.error && sessions.length === 0 && (
          <p className="text-sm text-muted">
            Standalone sessions are for direct work and automation — create one.
          </p>
        )}
        {sessions.length > 0 && (
          <ul className="space-y-1.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: s.id }}
                  className="flex items-center gap-2 text-sm text-ink hover:text-moss"
                >
                  <span
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.status === "active" ? "bg-moss" : "bg-muted")}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{s.title || "Untitled session"}</span>
                  <span className="shrink-0 text-xs text-muted">{relativeTime(s.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {childrenLine && (
          <Link to="/chat" className="block border-t border-line pt-2 text-xs text-moss hover:underline">
            {childrenLine}
          </Link>
        )}
      </div>
    </section>
  );
}
