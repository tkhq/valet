import { useId, useState, type ReactNode } from "react";
import { ChevronDown, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { ThreadPlanItem, ThreadPlanStatus, TurnProgress } from "@valet/shared";
import { useThreadProgress } from "~/api/thread-progress";
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
 * One execution surface above the composer. A successful empty progress
 * snapshot preserves plans from threads created before execution tracking.
 */
export function PinnedPlan({ threadId }: { threadId?: string }) {
  const progress = useThreadProgress(threadId);
  if (!threadId) return null;
  if (progress.isError) return <ProgressNotice>Progress unavailable. Refresh to retry.</ProgressNotice>;
  // Most threads have neither progress nor a plan, so nothing shows while it loads.
  if (progress.isPending) return null;
  if (progress.data.progress) return <PinnedProgress key={`${threadId}:${progress.data.progress.turnId}`} progress={progress.data.progress} />;
  return <LegacyPinnedPlan threadId={threadId} />;
}

function ProgressNotice({ children }: { children: ReactNode }) {
  return <div role="status" className="mx-auto mt-2 w-full max-w-[52rem] px-5 text-xs text-muted sm:px-8">{children}</div>;
}

/**
 * The thread's plan, every step at once. It shows while the plan has steps
 * left; a finished plan leaves, as Claude Code's to-do list does.
 */
function LegacyPinnedPlan({ threadId }: { threadId: string }) {
  const { data } = useThreadPlan(threadId);
  const plan = data?.plan;
  if (!plan?.items.some(item => item.status !== "done")) return null;
  return (
    <section aria-label="Plan" className="mx-auto mt-2 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {/* A long plan scrolls inside the card, so the composer stays on screen. */}
      <PlanChecklist items={plan.items} className={cn(cardClass, "max-h-64 overflow-y-auto overscroll-contain px-4 py-3")} />
    </section>
  );
}

const PROGRESS_LABEL: Record<TurnProgress["status"], string> = {
  pending: "Not started", in_progress: "In progress", waiting: "Waiting for input",
  complete: "Complete", error: "Failed", interrupted: "Interrupted",
};

const PROGRESS_TONE = {
  pending: "outline", in_progress: "info", waiting: "info",
  complete: "success", error: "danger", interrupted: "warning",
} as const;

function PinnedProgress({ progress }: { progress: TurnProgress }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const done = progress.tasks.filter(task => task.status === "complete").length;
  return (
    <section aria-label="Task progress" className="mx-auto mt-2 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      <div className={cardClass}>
        <Button variant="ghost" size="lg" aria-expanded={open} aria-controls={open ? listId : undefined}
          onClick={() => setOpen(!open)} className="w-full min-w-0 justify-start gap-2 whitespace-normal rounded-lg px-3 text-left font-normal">
          <StatusDot tone={PROGRESS_TONE[progress.status]} label={PROGRESS_LABEL[progress.status]} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink">{progress.title}</span>
            <span className="block text-xs text-muted">{PROGRESS_LABEL[progress.status]}{progress.tasks.length > 0 && ` · ${done} of ${progress.tasks.length + progress.omittedTasks} tasks`}</span>
          </span>
          <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-muted", open && "rotate-180")} />
        </Button>
        {open && <div id={listId} className="max-h-64 overflow-y-auto overscroll-contain border-t border-line px-3 py-2">
          <ol className="space-y-2 text-[13px] leading-5">
            {progress.tasks.map(task => <li key={task.id} className="min-w-0 [overflow-wrap:anywhere]">
              <div className="flex items-start gap-2">
                <StatusDot tone={PROGRESS_TONE[task.status]} label={PROGRESS_LABEL[task.status]} className="mt-1.5" />
                <span className="min-w-0 flex-1">{task.title}<span className="block text-xs text-muted">{PROGRESS_LABEL[task.status]}</span></span>
              </div>
              {task.details && <p className="mt-1 text-muted">{task.details}</p>}
              {task.output && <p className="mt-1 whitespace-pre-wrap">{task.output}</p>}
              {task.sources?.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-info underline">{source.title}</a>)}
            </li>)}
          </ol>
          {progress.omittedTasks > 0 && <p className="mt-2 text-xs text-muted">{progress.omittedTasks} more tasks</p>}
          {progress.tasks.length === 0 && <p className="text-xs text-muted">No tasks yet.</p>}
        </div>}
      </div>
    </section>
  );
}

/** The step Valet is on, for the working line. */
export function useCurrentStep(threadId?: string): string | undefined {
  return useThreadPlan(threadId).data?.plan?.items.find(item => item.status === "in_progress")?.text;
}
