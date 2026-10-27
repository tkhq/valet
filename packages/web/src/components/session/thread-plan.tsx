import { CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { ThreadPlanItem, ThreadPlanStatus } from "@valet/shared";
import { useThreadPlan } from "~/api/thread-plan";
import { cardClass } from "~/components/primitives";
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

const STEP: Record<ThreadPlanStatus, { label: string; text: string }> = {
  done: { label: "Done", text: "text-muted" },
  in_progress: { label: "In progress", text: "font-medium text-ink" },
  pending: { label: "Not started", text: "text-ink" },
};

/** A check once done, a spinner while running, an empty circle until then. */
function StepMark({ status }: { status: ThreadPlanStatus }) {
  const props = { role: "img", "aria-label": STEP[status].label } as const;
  if (status === "done") return <CircleCheck {...props} className="mt-0.5 h-4 w-4 shrink-0 text-success-600 dark:text-success-500" />;
  if (status === "in_progress") return <LoaderCircle {...props} className="mt-0.5 h-4 w-4 shrink-0 text-ink motion-safe:animate-spin" />;
  return <CircleDashed {...props} className="mt-0.5 h-4 w-4 shrink-0 text-muted" />;
}

/** The plan's items in order, as Claude Code shows its to-do list. */
export function PlanChecklist({ items, id, className }: { items: ThreadPlanItem[]; id?: string; className?: string }) {
  return (
    <ol id={id} className={cn("space-y-1.5 text-[13px] leading-5", className)}>
      {items.map((item, index) => (
        // Items hold no state, so an index key cannot hand state to the wrong item.
        <li key={index} className="flex min-w-0 items-start gap-2">
          <StepMark status={item.status} />
          <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", STEP[item.status].text)}>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The thread's plan above the composer, every step at once. It shows while
 * the plan has steps left; a finished plan leaves, as Claude Code's to-do
 * list does. A thread without a plan has only the working line.
 */
export function PinnedPlan({ threadId }: { threadId?: string }) {
  const { data } = useThreadPlan(threadId);
  const plan = data?.plan;
  if (!threadId || !plan?.items.some(item => item.status !== "done")) return null;
  return (
    <section aria-label="Plan" className="mx-auto mt-2 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {/* A long plan scrolls inside the card, so the composer stays on screen. */}
      <PlanChecklist items={plan.items} className={cn(cardClass, "max-h-64 overflow-y-auto overscroll-contain px-4 py-3")} />
    </section>
  );
}

/** The step Valet is on, for the working line. */
export function useCurrentStep(threadId?: string): string | undefined {
  return useThreadPlan(threadId).data?.plan?.items.find(item => item.status === "in_progress")?.text;
}
