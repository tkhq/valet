import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SecurityCellWire } from "@valet/api/wire";
import { cn } from "~/lib/cn";
import { CellRail, STATUS_DOT } from "./cell-rail";

const STORAGE_KEY = "valet:sec-steps-expanded";

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
 * cells) does not push the findings triage off screen. Expanded shows the full
 * cell rail in a bounded, self-scrolling area. The choice persists.
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
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse steps" : "Expand steps"}
        className="flex w-full items-center gap-2 border-b border-line px-4 pb-2 pt-3 text-left hover:bg-ink-wash/40"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        )}
        <h3 className="shrink-0 text-xs font-semibold text-ink">Steps</h3>
        <span className="shrink-0 text-[11px] tabular-nums text-muted">
          {done}/{total}
        </span>
        {!expanded && (
          <>
            {/* One dot per step — the whole plan's status at a glance. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="steps-strip">
              {ordered.map((cell) => (
                <span key={cell.id} className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
                  {cell.status === "running" && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-moss opacity-60" />
                  )}
                  <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", STATUS_DOT[cell.status])} />
                </span>
              ))}
            </div>
            {running && (
              <span className="shrink-0 truncate font-mono text-[11px] text-muted">{running.dir}</span>
            )}
          </>
        )}
      </button>
      {expanded && (
        <div className="max-h-80 overflow-y-auto">
          <CellRail cells={cells} onOpenChild={onOpenChild} />
        </div>
      )}
    </div>
  );
}
