import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SecurityCellWire } from "@valet/api/wire";
import { Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { CellRail, STATUS_DOT, elapsedLabel, progressLine, triadRole } from "./cell-rail";

const STORAGE_KEY = "valet:sec-steps-expanded";

const STATUS_LABEL: Record<SecurityCellWire["status"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  yielded: "Yielded",
  failed: "Failed",
};

/** Read the persisted expand state; default collapsed so the findings triage
 * below stays readable. Client-only — the panel never renders server-side. */
function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The engagement steps with a collapse/expand toggle (spec §engagement panel).
 * Collapsed (the default) is a one-line status strip — a dot per step plus the
 * done/total count and the running step — so a long plan (triads multiply the
 * cells) does not push the findings triage off screen. Each dot is live: hover
 * for that step's status, goal, and progress; click to open its child session
 * in the slide-over. Expanded shows the full cell rail. The choice persists.
 */
export function StepsPanel({
  cells,
  onOpenChild,
}: {
  cells: SecurityCellWire[];
  onOpenChild?: (childId: string) => void;
}) {
  const [expanded, setExpanded] = useState(readExpanded);

  // No cells yet: the rail owns the "materializes at start" empty state.
  if (cells.length === 0) {
    return <CellRail cells={cells} onOpenChild={onOpenChild} />;
  }

  const ordered = [...cells].sort((a, b) => a.ordinal - b.ordinal);
  const done = ordered.filter((c) => c.status === "completed").length;
  const total = ordered.length;
  const running = ordered.find((c) => c.status === "running");

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Persistence is best-effort; the toggle still works this session.
      }
      return next;
    });
  }

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 border-b border-line px-4 pb-2 pt-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse steps" : "Expand steps"}
          className="flex shrink-0 items-center gap-2 rounded hover:text-ink"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />
          )}
          <h3 className="text-xs font-semibold text-ink">Steps</h3>
          <span className="text-[11px] tabular-nums text-muted">
            {done}/{total}
          </span>
        </button>
        {!expanded && (
          <>
            {/* One dot per step — the whole plan at a glance. Each dot is a live
                handle: hover for the step's state, click to open its child. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5" data-testid="steps-strip">
              {ordered.map((cell) => (
                <StepDot key={cell.id} cell={cell} onOpenChild={onOpenChild} />
              ))}
            </div>
            {running && (
              <span className="shrink-0 truncate font-mono text-[11px] text-muted">{running.dir}</span>
            )}
          </>
        )}
      </div>
      {expanded && (
        <div className="max-h-80 overflow-y-auto">
          <CellRail cells={cells} onOpenChild={onOpenChild} />
        </div>
      )}
    </div>
  );
}

/** One step's dot in the collapsed strip. Hover shows a live overview; a cell
 * with a child session is a button that opens it in the slide-over. */
function StepDot({
  cell,
  onOpenChild,
}: {
  cell: SecurityCellWire;
  onOpenChild?: (childId: string) => void;
}) {
  const running = cell.status === "running";
  const role = triadRole(cell.persona);
  const elapsedMs =
    running && cell.dispatchedAt !== null ? Date.now() - cell.dispatchedAt : null;

  const overview = (
    <div className="max-w-[15rem] space-y-1 text-left">
      <div className="flex items-center gap-1.5">
        <span className="font-mono font-medium text-ink">{cell.dir}</span>
        <span className="text-muted">· {role ?? cell.persona}</span>
      </div>
      <div className="text-muted">
        {STATUS_LABEL[cell.status]}
        {running && elapsedMs !== null ? ` · ${elapsedLabel(elapsedMs)}` : ""}
        {cell.attempts > 1 ? ` · attempt ${cell.attempts}` : ""}
      </div>
      {cell.goal && <div className="text-ink">{cell.goal}</div>}
      {running && cell.progress && (
        <div className="font-mono text-[11px] text-muted">{progressLine(cell.progress)}</div>
      )}
      {cell.childSessionId && (
        <div className="text-[11px] text-moss">Click to open the child session →</div>
      )}
    </div>
  );

  const dot = (
    <span className="relative flex h-2 w-2" aria-hidden>
      {running && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-moss opacity-60" />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", STATUS_DOT[cell.status])} />
    </span>
  );

  const child = cell.childSessionId;
  return (
    <Tooltip content={overview}>
      {child ? (
        <button
          type="button"
          onClick={() => onOpenChild?.(child)}
          aria-label={`${cell.dir}: ${STATUS_LABEL[cell.status]} — open child session`}
          className="flex items-center rounded-full p-0.5 hover:bg-ink-wash focus:outline-none focus-visible:ring-1 focus-visible:ring-moss"
        >
          {dot}
        </button>
      ) : (
        <span
          tabIndex={0}
          aria-label={`${cell.dir}: ${STATUS_LABEL[cell.status]}`}
          className="flex items-center p-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-moss"
        >
          {dot}
        </span>
      )}
    </Tooltip>
  );
}
