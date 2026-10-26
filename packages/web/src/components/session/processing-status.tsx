import type { WireQueueState } from "@valet/api/wire";
import type { AgentStatus } from "~/stores/stream";
import { cn } from "~/lib/cn";

/** The queue also covers work submitted outside this browser and reconnects. */
export function ProcessingStatus({ status, queue, needsResponse = false }: {
  status: AgentStatus;
  queue?: WireQueueState;
  needsResponse?: boolean;
}) {
  const waiting = needsResponse || status === "blocked_on_decision_gate" || queue?.status === "blocked_on_decision_gate";
  const running = status === "thinking" || status === "tool_calling" || status === "streaming"
    || queue?.status === "running" || (queue?.status === "paused" && Boolean(queue.activeItemId));
  const paused = queue?.status === "paused" && !running;
  const queued = status === "queued" || queue?.status === "queued"
    || Boolean(queue?.pendingIds.length || queue?.collectingIds.length);
  const label = waiting ? "Valet is waiting for a response"
    : running ? status === "thinking" ? "Valet is thinking…" : "Valet is working…"
    : paused ? "Valet is paused"
    : queued ? "Valet is queued" : undefined;

  // Keep the live region mounted so status changes are announced once.
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className="mx-auto w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {/* One quiet line, not a card: the task card above it is the only box. */}
      {label && <div className="my-3 flex items-center gap-2 px-1 text-xs text-muted md:my-2 md:text-[13px]">
        <img src="/icons/valet-mascot.webp" alt="" width={20} height={20} className={cn("h-5 w-5 shrink-0 object-contain", running && !waiting && "motion-safe:animate-pulse")} />
        <span>{label}</span>
      </div>}
    </div>
  );
}
