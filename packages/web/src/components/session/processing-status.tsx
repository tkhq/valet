import type { WireQueueState } from "@valet/api/wire";
import type { AgentStatus } from "~/stores/stream";
import { StatusDot } from "~/components/primitives";

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
      {label && <div className="my-3 flex items-center gap-2 px-1 text-xs font-normal text-muted md:mb-2 md:mt-0 md:rounded-lg md:border md:border-line md:bg-ink-wash md:px-3 md:py-2 md:text-sm md:font-medium md:text-ink">
        <img src="/icons/valet-mascot.webp" alt="" width={20} height={20} className="h-5 w-5 shrink-0 object-contain md:hidden" />
        <StatusDot className="hidden md:block" tone={waiting || paused ? "warning" : "info"} pulse={running && !waiting} />
        <span>{label}</span>
      </div>}
    </div>
  );
}
