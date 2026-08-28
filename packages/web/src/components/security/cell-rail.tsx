import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Archive, ExternalLink } from "lucide-react";
import type { SecurityCellWire } from "@valet/api/wire";
import { Badge, Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * The engagement's ordered cells (valet-security design §engagement panel):
 * ordinal + dir, persona, status, attempts past the first, elapsed time and
 * live state-doc progress while running, a compaction badge from the
 * compaction hook, an over-age warning past 30 minutes (surfaced, never
 * auto-repaired — the alert-don't-auto-repair rule), and a link to the
 * cell's child session.
 */

/** Running past this with no settled child renders the warning state. */
export const OVER_AGE_MS = 30 * 60 * 1000;

const STATUS_VARIANT: Record<SecurityCellWire["status"], "neutral" | "accent" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  running: "accent",
  completed: "success",
  yielded: "warning",
  failed: "danger",
};

/** `checklist 14/47 · queue 3 pending` — done/total from the state doc's
 * counters, per the spec's example line. */
export function progressLine(progress: NonNullable<SecurityCellWire["progress"]>): string {
  const checklistTotal = progress.checklist.done + progress.checklist.pending;
  return `checklist ${progress.checklist.done}/${checklistTotal} · queue ${progress.queue.pending} pending`;
}

/** `4m`, `1h 12m` — coarse on purpose; the rail re-renders on a slow tick. */
export function elapsedLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A slow clock for elapsed/over-age labels: one shared 30s tick instead of
 * a timer per cell. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function CellRail({
  cells,
  onOpenChild,
}: {
  cells: SecurityCellWire[];
  onOpenChild?: (childId: string) => void;
}) {
  const now = useNow();
  if (cells.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted">
        No cells yet. The runner materializes them when the engagement starts.
      </div>
    );
  }
  const ordered = [...cells].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <ol className="divide-y divide-line" aria-label="Engagement cells">
      {ordered.map((cell) => (
        <CellRow key={cell.id} cell={cell} now={now} onOpenChild={onOpenChild} />
      ))}
    </ol>
  );
}

function CellRow({
  cell,
  now,
  onOpenChild,
}: {
  cell: SecurityCellWire;
  now: number;
  onOpenChild?: (childId: string) => void;
}) {
  const running = cell.status === "running";
  const elapsedMs = running && cell.dispatchedAt !== null ? now - cell.dispatchedAt : null;
  // Over-age: still running, no settled child, 30+ minutes in. `settledAt`
  // is null for the life of the attempt, so elapsed alone is the signal.
  const overAge = running && elapsedMs !== null && elapsedMs > OVER_AGE_MS;

  return (
    <li
      className={cn(
        "px-4 py-2.5 text-xs",
        overAge && "bg-warning-wash/60 border-l-2 border-l-amber-500",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono font-medium text-ink truncate">{cell.dir}</span>
        <span className="text-muted">{cell.persona}</span>
        <Badge variant={STATUS_VARIANT[cell.status]}>{cell.status}</Badge>
        {cell.attempts > 1 && <span className="text-muted">attempt {cell.attempts}</span>}
        {elapsedMs !== null && (
          <span className={cn("tabular-nums", overAge ? "text-warning-fg font-medium" : "text-muted")}>
            {elapsedLabel(elapsedMs)}
          </span>
        )}
        {cell.compactedAt !== null && (
          <Tooltip content="This cell's context was compacted; state is checkpointed in the tree.">
            <span
              className="inline-flex items-center gap-0.5 text-muted"
              aria-label="Context compacted"
            >
              <Archive className="h-3 w-3" aria-hidden />
              compacted
            </span>
          </Tooltip>
        )}
        <span className="flex-1" />
        {cell.childSessionId !== null &&
          (onOpenChild ? (
            // Open the persona child as the in-page `?child=` slide-over (the
            // same ChildPanel the chat UI uses), not its standalone page.
            <button
              type="button"
              onClick={() => onOpenChild(cell.childSessionId!)}
              className="inline-flex items-center gap-1 text-muted hover:text-moss shrink-0"
              aria-label={`Open ${cell.dir} child session`}
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              session
            </button>
          ) : (
            // No handler (e.g. standalone rendering) — fall back to the page.
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: cell.childSessionId }}
              className="inline-flex items-center gap-1 text-muted hover:text-moss shrink-0"
              aria-label={`Open ${cell.dir} child session`}
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              session
            </Link>
          ))}
      </div>
      <div className="mt-0.5 text-muted truncate">{cell.goal}</div>
      {running && cell.progress && (
        <div className="mt-0.5 font-mono text-[11px] text-ink/80">{progressLine(cell.progress)}</div>
      )}
      {overAge && (
        <div className="mt-0.5 text-[11px] text-warning-fg">
          Running over 30 minutes with no settled child. Check the child session.
        </div>
      )}
    </li>
  );
}
