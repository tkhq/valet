import type { AgentStatus } from "~/stores/stream";
import { StatusDot, Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";

/** The one state a thread row shows. The order is the priority. */
export type ThreadRowState = "needs_you" | "failed" | "working" | "unread" | "none";

export interface ThreadRowSignals {
  /** A decision gate waits on this thread. */
  pendingGate: boolean;
  /** The question Valet asked that nobody answered yet (`pendingAgentQuestion`). */
  question?: string;
  /** The live agent status of the thread. */
  status: AgentStatus;
  /** The thread's queue runs or waits on a turn (`queueBusy`). */
  busy: boolean;
  /** The agent wrote after the viewer last read the thread. */
  unread: boolean;
}

/** True when the thread waits on a person: a pending gate or an open question. */
export function threadNeedsYou(signals: Pick<ThreadRowSignals, "pendingGate" | "question"> & Partial<Pick<ThreadRowSignals, "status">>): boolean {
  // A turn blocked on a gate needs a person before the gate itself has loaded.
  return signals.pendingGate || signals.question !== undefined || signals.status === "blocked_on_decision_gate";
}

/** Pure: the row's one state. Needs you comes first, then failed, working, and unread. */
export function threadRowState(signals: ThreadRowSignals): ThreadRowState {
  if (threadNeedsYou(signals)) return "needs_you";
  if (signals.status === "error") return "failed";
  if (signals.busy || signals.status !== "idle") return "working";
  return signals.unread ? "unread" : "none";
}

/** The row title's weight and color for each state. */
export const THREAD_TITLE_CLASS: Record<ThreadRowState, string> = {
  needs_you: "font-medium text-ink",
  failed: "",
  working: "",
  unread: "font-medium",
  none: "",
};

const DOT: Record<"needs_you" | "failed" | "unread", { tone: "warning" | "danger" | "info"; label: string }> = {
  needs_you: { tone: "warning", label: "Needs approval" },
  failed: { tone: "danger", label: "Thread failed" },
  unread: { tone: "info", label: "Unread" },
};

// Staggered, so the three dots light up one after the other.
const WORKING_DOTS = ["animate-working-dot", "animate-working-dot-2", "animate-working-dot-3"] as const;

/**
 * The one status mark at the end of a thread row: an amber dot when the
 * thread needs you, a red dot when it failed, three moving dots while it
 * works, and a blue dot when it is unread. A question gives the amber dot
 * its text as the tooltip.
 */
export function ThreadStateMark({ state, question, className }: {
  state: ThreadRowState;
  /** Shown for `needs_you` when Valet asked a question. */
  question?: string;
  className?: string;
}) {
  if (state === "none") return null;
  const asked = state === "needs_you" && question !== undefined;
  const label = state === "working" ? "Working" : asked ? "Valet asked you a question" : DOT[state].label;
  return (
    <Tooltip content={asked ? `Valet asks: ${question}` : label}>
      <span className={cn("inline-flex h-5 min-w-5 shrink-0 items-center justify-center", className)}>
        {state === "working" ? (
          <span role="img" aria-label={label} className="inline-flex items-center gap-0.5">
            {WORKING_DOTS.map((animation) => (
              <StatusDot key={animation} tone="info" size="sm" className={cn(animation, "motion-reduce:animate-none")} />
            ))}
          </span>
        ) : (
          <StatusDot tone={DOT[state].tone} label={label} />
        )}
      </span>
    </Tooltip>
  );
}
