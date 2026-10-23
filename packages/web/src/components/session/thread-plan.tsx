import { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { planProgress, type ThreadPlanItem, type ThreadPlanStatus } from "@valet/shared";
import { useThreadPlan } from "~/api/thread-plan";
import { Button, cardClass, StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";

/** "2 of 5" with a thin bar. For a plan bar, a task row, or a card. */
export function PlanProgress({ done, total, label, className }: { done: number; total: number; label?: string; className?: string }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 tabular-nums", className)}>
      <span aria-hidden className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-ink-wash">
        <span className="block h-full rounded-full bg-moss" style={{ width: `${percent}%` }} />
      </span>
      <span className="whitespace-nowrap">{label ? `${label} · ` : ""}{done} of {total}</span>
    </span>
  );
}

// Done items recede (muted dot, struck text). Blue marks the live item, as it marks a running thread.
const ITEM: Record<ThreadPlanStatus, { tone: "neutral" | "info" | "outline"; label: string; text: string }> = {
  done: { tone: "neutral", label: "Done", text: "text-muted line-through" },
  in_progress: { tone: "info", label: "In progress", text: "font-medium text-ink" },
  pending: { tone: "outline", label: "Not started", text: "text-ink" },
};

/** The plan's items in order: done items struck through, the current item in bold. */
export function PlanChecklist({ items, id, className }: { items: ThreadPlanItem[]; id?: string; className?: string }) {
  return (
    <ol id={id} className={cn("space-y-1 text-[13px] leading-5", className)}>
      {items.map((item, index) => (
        // Items hold no state, so an index key cannot hand state to the wrong item.
        <li key={index} className="flex min-w-0 items-start gap-2">
          <StatusDot tone={ITEM[item.status].tone} label={ITEM[item.status].label} className="mt-1.5" />
          <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", ITEM[item.status].text)}>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The thread's plan, docked above the composer: one row with progress and
 * the current item. A click opens the full checklist. Hidden while the
 * thread has no plan.
 */
export function PinnedPlan({ threadId }: { threadId?: string }) {
  const { data } = useThreadPlan(threadId);
  // Keyed by thread, so a thread switch shows the next plan collapsed.
  const [openFor, setOpenFor] = useState<string>();
  const listId = useId();
  const plan = data?.plan;
  if (!plan || !threadId) return null;
  const open = openFor === threadId;
  const { done, total, current } = planProgress(plan);
  const finished = done === total;
  return (
    <section aria-label="Plan" className="mx-auto mt-2 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      <div className={cardClass}>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpenFor(open ? undefined : threadId)}
          className={cn("w-full min-w-0 justify-start rounded-lg px-3 font-normal", open && "rounded-b-none")}
        >
          <PlanProgress done={done} total={total} label={finished ? "Plan done" : "Plan"} className="text-muted" />
          {!finished && current !== undefined && <span className="min-w-0 flex-1 truncate text-left text-ink">{current}</span>}
          {open
            ? <ChevronUp className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            : <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
        </Button>
        {/* A long plan scrolls inside the card, so the composer stays on screen. */}
        {open && <PlanChecklist id={listId} items={plan.items} className="max-h-64 overflow-y-auto overscroll-contain border-t border-line px-3 py-2" />}
      </div>
    </section>
  );
}
