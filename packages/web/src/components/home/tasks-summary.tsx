import { StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * One line that says where everything stands: "2 need you · 4 in progress ·
 * 3 finished". Zero counts are left out; with nothing at all it says so.
 */
export function TasksSummary({ needsYou, working, finished, className }: {
  needsYou: number; working: number; finished: number; className?: string;
}) {
  const parts = [
    needsYou > 0 && { key: "needs", tone: "warning" as const, text: `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` },
    working > 0 && { key: "working", tone: "info" as const, text: `${working} in progress` },
    finished > 0 && { key: "finished", tone: "neutral" as const, text: `${finished} finished` },
  ].filter((part): part is { key: string; tone: "warning" | "info" | "neutral"; text: string } => Boolean(part));
  return <p className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted", className)} aria-live="polite">
    {parts.length === 0 ? "Nothing in flight." : parts.map(part =>
      <span key={part.key} className="inline-flex items-center gap-1.5"><StatusDot tone={part.tone} size="sm" />{part.text}</span>)}
  </p>;
}
