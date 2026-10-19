/**
 * One section of the editor's form (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 2): the name in a fixed left column, the summary in words,
 * and `Change` or `Close`. An open section shows its body under the row.
 * The sheet holds which section is open, so one is open at a time.
 */
import { useId, type ReactNode } from "react";
import { Button } from "~/components/primitives";
import { cn } from "~/lib/cn";

export type SectionId = "when" | "do" | "where" | "appears" | "name";

export function Section({
  id,
  name,
  summary,
  muted = false,
  open,
  onToggle,
  fixed = false,
  children,
}: {
  id: SectionId;
  name: string;
  summary: ReactNode;
  /** True while the summary reads a default the reader did not choose. */
  muted?: boolean;
  open: boolean;
  onToggle: () => void;
  /** True for a section with nothing to change: it shows no toggle. */
  fixed?: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();
  const bodyId = `${headingId}-body`;
  return (
    <section
      aria-labelledby={headingId}
      data-section={id}
      className="border-t border-line py-4 first:border-t-0 first:pt-0"
    >
      <div className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-baseline gap-4">
        <h2 id={headingId} className="text-[13px] font-medium text-ink">{name}</h2>
        <p className={cn("min-w-0 text-[15px] leading-relaxed [overflow-wrap:anywhere]", muted ? "text-muted" : "text-ink")}>
          {typeof summary === "string" ? <span className={muted ? "text-muted" : undefined}>{summary}</span> : summary}
        </p>
        {fixed ? <span /> : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            aria-label={`${open ? "Close" : "Change"} ${name}`}
            className="h-auto px-1.5 py-0.5 text-[13px] font-normal text-accent-600 dark:text-accent-400"
            onClick={onToggle}
          >
            {open ? "Close" : "Change"}
          </Button>
        )}
      </div>
      {open && !fixed && (
        <div id={bodyId} data-section-body className="mt-3.5 grid min-w-0 gap-4 sm:ml-[88px]">
          {children}
        </div>
      )}
    </section>
  );
}
