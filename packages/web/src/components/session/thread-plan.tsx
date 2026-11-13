import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { Message } from "@valet/api/wire";
import type { ThreadPlanItem, ThreadPlanStatus, TurnProgress } from "@valet/shared";
import { useThreadProgress } from "~/api/thread-progress";
import { useThreadPlan } from "~/api/thread-plan";
import { Button, cardClass, StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";
import type { ToolCallPart } from "./tool-call-block";
import { CallSteps, stepView } from "./work-group";
import { useThreadSources } from "./citations";
import { useWorkingLine, type WorkingLineInput } from "./processing-status";

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

/** A card for a turn that still runs carries the working line. */
function activeProgress(progress: TurnProgress): boolean {
  return progress.status === "pending" || progress.status === "in_progress" || progress.status === "waiting";
}

/** The working line moves into the card only while that card is visible. */
export function useProgressCardActive(threadId?: string): boolean {
  const progress = useThreadProgress(threadId);
  return progress.isSuccess && Boolean(progress.data.progress && activeProgress(progress.data.progress));
}

/**
 * One execution surface above the composer. A successful empty progress
 * snapshot preserves plans from threads created before execution tracking.
 * An active card carries the live status and clock instead of a second row.
 * `messages` holds the tool calls the card shows as steps.
 */
export function PinnedPlan({ threadId, live, messages = [], readOnly = false }: { threadId?: string; live?: WorkingLineInput; messages?: readonly Message[]; readOnly?: boolean }) {
  const progress = useThreadProgress(threadId);
  if (!threadId) return null;
  if (progress.isError) return <ProgressNotice>Progress unavailable. Refresh to retry.</ProgressNotice>;
  // Most threads have neither progress nor a plan, so nothing shows while it loads.
  if (progress.isPending) return null;
  const current = progress.data.progress;
  if (current) {
    // A settled turn with no tasks and no calls has nothing to show; its
    // card would read "Complete" over "No tasks yet" until the next turn.
    if (!activeProgress(current) && current.tasks.length === 0 && current.omittedTasks === 0 && turnCalls(current, messages).length === 0) return null;
    return <PinnedProgress key={`${threadId}:${current.turnId}`} progress={current} live={live} messages={messages} readOnly={readOnly} />;
  }
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

/** The mascot while Valet works on it, a green check once it is done, and a
 * dot for the states that ask for attention. Same mark as the working line.
 * Done is green, not `moss`: a theme may make `moss` its brand color. */
function ProgressMark({ status, small = false }: { status: TurnProgress["status"]; small?: boolean }) {
  const size = small ? "h-4 w-4" : "h-5 w-5";
  if (status === "in_progress") {
    return <img src="/icons/valet-mascot.webp" alt={PROGRESS_LABEL[status]} width={20} height={20} className={cn(size, "shrink-0 object-contain motion-safe:animate-pulse")} />;
  }
  if (status === "complete") return <Check role="img" aria-label={PROGRESS_LABEL[status]} className={cn(size, "shrink-0 text-success-600 dark:text-success-500")} />;
  return <span className={cn(size, "flex shrink-0 items-center justify-center")}><StatusDot tone={PROGRESS_TONE[status]} label={PROGRESS_LABEL[status]} /></span>;
}

/** Pure: the turn's tool calls the loaded messages hold, in call order. */
export function turnCalls(progress: TurnProgress, messages: readonly Message[]): ToolCallPart[] {
  if (!progress.callIds?.length) return [];
  const byId = new Map<string, ToolCallPart>();
  for (const message of messages) {
    for (const part of message.parts) if (part.kind === "tool_call") byId.set(part.callId, part);
  }
  return progress.callIds.flatMap(id => byId.get(id) ?? []);
}

const NO_CHILDREN: ReadonlyMap<string, string> = new Map();
const IDLE_LINE: WorkingLineInput = { status: "idle" };

/** The card's second line: what runs now, the count, and the clock. */
function progressSummary(progress: TurnProgress, calls: readonly ToolCallPart[], notice: string | undefined): string {
  const done = progress.tasks.filter(task => task.status === "complete").length;
  const total = progress.tasks.length + progress.omittedTasks;
  const runningCall = [...calls].reverse().find(call => call.status === "running");
  // A running call says what it does; a task title from the engine is generic.
  const current = (runningCall && stepView(runningCall, NO_CHILDREN).title) ?? progress.tasks.find(task => task.status === "in_progress")?.title;
  const running = progress.status === "in_progress";
  // Every task is done but the turn has not settled: it is writing the answer.
  const wrappingUp = running && total > 0 && done === total;
  const lead = notice ?? (wrappingUp ? "Wrapping up" : running && current ? current : PROGRESS_LABEL[progress.status]);
  return total > 0 ? `${lead} · ${done} of ${total} done` : lead;
}

function PinnedProgress({ progress, live, messages, readOnly }: { progress: TurnProgress; live?: WorkingLineInput; messages: readonly Message[]; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const active = Boolean(live) && activeProgress(progress);
  const line = useWorkingLine(active && live ? live : IDLE_LINE);
  const calls = useMemo(() => turnCalls(progress, messages), [progress, messages]);
  const { reveal } = useThreadSources();
  const revealKey = reveal && calls.some(call => call.callId === reveal.callId) ? reveal.key : undefined;
  useEffect(() => { if (revealKey !== undefined) setOpen(true); }, [revealKey]);
  // A call the messages hold shows as its own step, so its generic task row goes.
  const shown = new Set(calls.map(call => `tool:${call.callId}`));
  const tasks = progress.tasks.filter(task => !shown.has(task.id));
  const steps = calls.length > 0 && <CallSteps calls={calls} readOnly={readOnly} />;
  return (
    <section aria-label="Task progress" className="mx-auto mt-2 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      <div className={cardClass}>
        {/* Two lines of text: the card grows with them instead of the
            fixed lg height, which left no room above or below. */}
        <Button variant="ghost" size="lg" aria-expanded={open} aria-controls={open ? listId : undefined}
          onClick={() => setOpen(!open)} className="h-auto w-full min-w-0 justify-start gap-3 whitespace-normal rounded-lg px-4 py-3 text-left font-normal">
          <ProgressMark status={progress.status} />
          <span className="min-w-0 flex-1">
            <span className="block truncate leading-5 text-ink">{progress.title}</span>
            <span className="mt-0.5 flex min-w-0 gap-2 text-xs leading-4 text-muted">
              <span className="min-w-0 truncate">{progressSummary(progress, calls, line.notice)}</span>
              {line.elapsed && <span aria-hidden className="shrink-0 tabular-nums">{line.elapsed}</span>}
            </span>
          </span>
          <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-muted", open && "rotate-180")} />
        </Button>
        {open && <div id={listId} className="max-h-64 overflow-y-auto overscroll-contain border-t border-line px-4 py-3">
          {!progress.planned && steps}
          {tasks.length > 0 && <ol className={cn("space-y-3 text-[13px] leading-5", !progress.planned && steps && "mt-3")}>
            {tasks.map(task => <li key={task.id} className="min-w-0 [overflow-wrap:anywhere]">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5"><ProgressMark status={task.status} small /></span>
                <span className="min-w-0 flex-1">{task.title}<span className="block text-xs text-muted">{PROGRESS_LABEL[task.status]}</span></span>
              </div>
              {task.details && <p className="mt-1 text-muted">{task.details}</p>}
              {task.output && <p className="mt-1 whitespace-pre-wrap">{task.output}</p>}
              {task.sources?.filter(source => /^https?:\/\//i.test(source.url)).map((source, index) => <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-info underline">{source.title}</a>)}
            </li>)}
          </ol>}
          {/* The plan says what the turn means to do; its calls show what it did. */}
          {progress.planned && steps && <div className="mt-3 border-t border-line pt-3">{steps}</div>}
          {/* The engine bounds its task rows; the calls above replace them. */}
          {progress.omittedTasks > 0 && (progress.planned || calls.length === 0) && <p className="mt-2 text-xs text-muted">{progress.omittedTasks} more tasks</p>}
          {progress.tasks.length === 0 && calls.length === 0 && <p className="text-xs text-muted">No tasks yet.</p>}
        </div>}
      </div>
    </section>
  );
}

/** The step Valet is on, for the working line. */
export function useCurrentStep(threadId?: string): string | undefined {
  return useThreadPlan(threadId).data?.plan?.items.find(item => item.status === "in_progress")?.text;
}
