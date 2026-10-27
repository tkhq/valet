import { useEffect, useState } from "react";
import type { WireQueueState } from "@valet/api/wire";
import type { AgentStatus } from "~/stores/stream";
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

/**
 * One line under the plan, as Claude Code shows its activity: the step Valet
 * is on (or that it is thinking) and how long the turn has run. The queue
 * also covers work submitted outside this browser and reconnects.
 */
export function ProcessingStatus({ status, queue, needsResponse = false, activity, startedAt }: {
  status: AgentStatus;
  queue?: WireQueueState;
  needsResponse?: boolean;
  /** The plan step in progress, shown in place of the generic label. */
  activity?: string;
  /** When the running turn started, for the elapsed time. */
  startedAt?: number;
}) {
  const waiting = needsResponse || status === "blocked_on_decision_gate" || queue?.status === "blocked_on_decision_gate";
  const running = status === "thinking" || status === "tool_calling" || status === "streaming"
    || queue?.status === "running" || (queue?.status === "paused" && Boolean(queue.activeItemId));
  const paused = queue?.status === "paused" && !running;
  const queued = status === "queued" || queue?.status === "queued"
    || Boolean(queue?.pendingIds.length || queue?.collectingIds.length);
  const working = running && !waiting;
  const label = waiting ? "Valet is waiting for a response"
    : running ? activity ?? (status === "thinking" ? "Valet is thinking…" : "Valet is working…")
    : paused ? "Valet is paused"
    : queued ? "Valet is queued" : undefined;
  const now = useNow(working && startedAt !== undefined);

  // Keep the live region mounted so status changes are announced once. The
  // clock sits outside it: a reader should not hear it every second.
  return (
    <div className="mx-auto w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {/* One quiet line, not a card: the plan above it is the only box. */}
      <div className={cn("flex min-w-0 items-center gap-2 px-1 text-xs text-muted md:text-[13px]", label && "my-3 md:my-2")}>
        {label && <img src="/icons/valet-mascot.webp" alt="" width={20} height={20} className={cn("h-5 w-5 shrink-0 object-contain", working && "motion-safe:animate-pulse")} />}
        <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate">{label}</span>
        {label && working && startedAt !== undefined && <span aria-hidden className="shrink-0 tabular-nums">{formatElapsed(now - startedAt)}</span>}
      </div>
    </div>
  );
}
