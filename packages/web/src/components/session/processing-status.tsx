import { useEffect, useState } from "react";
import type { WireQueueState } from "@valet/api/wire";
import { providerLabel } from "@valet/shared";
import type { AgentStatus, ThreadRetry } from "~/stores/stream";
import { cn } from "~/lib/cn";

/** "25s", "3m 5s", "1h 2m": how long the turn has run. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Re-renders once a second while `active`, for a running clock. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const RETRY_CAUSE: Record<ThreadRetry["reason"], string> = {
  overloaded: "is overloaded",
  rate_limited: "is limiting requests",
  server_error: "had a server error",
  network: "is unreachable",
  usage_limit: "hit its usage limit",
  auth: "refused the key",
  rejected: "rejected the request",
  unknown: "failed",
};

/**
 * The working line while a turn waits on a retry, as Claude Code shows
 * "Retrying in Ns · attempt x/y". A retry is progress: it never reads as a
 * failure. Exported for tests.
 */
export function retryLabel(retry: ThreadRetry, now: number): string {
  const provider = providerLabel(retry.provider);
  if (retry.action === "fallback") {
    return `${provider} ${RETRY_CAUSE[retry.reason]}. Continuing with ${providerLabel(retry.toProvider)}…`;
  }
  const left = Math.ceil(Math.max(0, retry.at + (retry.waitMs ?? 0) - now) / 1000);
  const when = left > 0 ? `Retrying in ${left}s` : "Retrying";
  const attempt = retry.attempt !== undefined && retry.maxAttempts !== undefined ? ` · attempt ${retry.attempt}/${retry.maxAttempts}` : "";
  return `${provider} ${RETRY_CAUSE[retry.reason]}. ${when}${attempt}`;
}

export interface WorkingLineInput {
  status: AgentStatus;
  queue?: WireQueueState;
  needsResponse?: boolean;
  /** The plan step in progress, shown in place of the generic label. */
  activity?: string;
  /** When the running turn started, for the elapsed time. */
  startedAt?: number;
  /** A failed model call the turn retries. It replaces the label. */
  retry?: ThreadRetry;
  /** The thread is compacting its context, during a turn or between turns. */
  compacting?: boolean;
}

export interface WorkingLine {
  /** The whole line: the notice, else the step or a generic working label. */
  label?: string;
  /** Waiting, compacting, a retry, paused or queued: it replaces the step. */
  notice?: string;
  running: boolean;
  busy: boolean;
  /** How long the turn (or the compaction) has run, while busy. */
  elapsed?: string;
}

/** The working line's text and clock, for this row or the task card. */
export function useWorkingLine({ status, queue, needsResponse = false, activity, startedAt, retry, compacting = false }: WorkingLineInput): WorkingLine {
  const waiting = needsResponse || status === "blocked_on_decision_gate" || queue?.status === "blocked_on_decision_gate";
  const running = status === "thinking" || status === "tool_calling" || status === "streaming"
    || queue?.status === "running" || (queue?.status === "paused" && Boolean(queue.activeItemId));
  const paused = queue?.status === "paused" && !running;
  const queued = status === "queued" || queue?.status === "queued"
    || Boolean(queue?.pendingIds.length || queue?.collectingIds.length);
  const working = running && !waiting;
  const retrying = working && retry !== undefined;
  // Compaction between turns has no turn clock: time it from when it began.
  const [compactingSince, setCompactingSince] = useState<number>();
  useEffect(() => setCompactingSince(compacting ? Date.now() : undefined), [compacting]);
  const busy = working || (compacting && !waiting);
  const clockFrom = working ? startedAt : compacting && !waiting ? startedAt ?? compactingSince : undefined;
  const now = useNow(clockFrom !== undefined || retrying);
  const notice = waiting ? "Valet is waiting for a response"
    : compacting ? "Valet is compacting context…"
    : retrying ? retryLabel(retry, now)
    : running ? undefined
    : paused ? "Valet is paused"
    : queued ? "Valet is queued" : undefined;
  const label = notice ?? (running ? activity ?? (status === "thinking" ? "Valet is thinking…" : "Valet is working…") : undefined);
  const elapsed = label && busy && clockFrom !== undefined ? formatElapsed(now - clockFrom) : undefined;
  return { label, notice, running: working, busy, elapsed };
}

/**
 * One line under the plan, as Claude Code shows its activity: the step Valet
 * is on (or that it is thinking or compacting context) and how long the turn
 * has run. The queue also covers work submitted outside this browser and
 * reconnects. While the task card shows, the card carries this line and the
 * row keeps only its announcement.
 */
export function ProcessingStatus({ inCard = false, ...input }: WorkingLineInput & {
  /** The task card shows the line: render no second row or mascot. */
  inCard?: boolean;
}) {
  const { label, busy, elapsed } = useWorkingLine(input);
  // Keep the live region mounted so status changes are announced once. The
  // clock sits outside it: a reader should not hear it every second.
  if (inCard) return <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{label}</span>;
  return (
    <div className="mx-auto w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {/* One quiet line, not a card: the plan above it is the only box. */}
      <div className={cn("flex min-w-0 items-center gap-2 px-1 text-xs text-muted md:text-[13px]", label && "my-3 md:my-2")}>
        {label && <img src="/icons/valet-mascot.webp" alt="" width={20} height={20} className={cn("h-5 w-5 shrink-0 object-contain", busy && "motion-safe:animate-pulse")} />}
        <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate">{label}</span>
        {elapsed && <span aria-hidden className="shrink-0 tabular-nums">{elapsed}</span>}
      </div>
    </div>
  );
}
