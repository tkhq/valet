import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { Tooltip, StatusDot } from "~/components/primitives";

/** Activity is not PR state: ready does not mean a pull request was merged. */
export function ThreadStatusIcon({ status, busy = false, needsApproval = false, conn }: {
  status: AgentStatus;
  busy?: boolean;
  needsApproval?: boolean;
  conn?: ConnectionStatus;
}) {
  const disconnected = conn !== undefined && conn !== "open";
  const waiting = needsApproval || status === "blocked_on_decision_gate";
  const working = busy || (status !== "idle" && status !== "error");
  const label = waiting ? "Needs approval" : status === "error" ? "Thread failed" : disconnected ? "Thread status unavailable — reconnecting" : working ? "Working" : "Ready";
  if (!waiting && status === "idle" && !busy && !disconnected) return null;
  return (
    <Tooltip content={label}>
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <StatusDot label={label} pulse={working && !waiting && !disconnected && status !== "error"}
          tone={waiting ? "warning" : status === "error" ? "danger" : disconnected ? "outline" : working ? "info" : "neutral"} />
      </span>
    </Tooltip>
  );
}
