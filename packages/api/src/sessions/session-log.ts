/**
 * Session log projection (V1 port #8).
 *
 * V1 kept a per-session log panel fed by a dedicated log channel. V2 needs
 * no new writer: the engine already appends every event it emits to a
 * durable, per-session, sequence-numbered stream (`engine_events`, written
 * by `PgEventStream.append`). This module is the read half — it turns those
 * rows into lines a person reads.
 *
 * Two things are deliberately dropped:
 *
 * - The streaming plane (`text_delta`, `tool_call_update`, `message_delta`).
 *   Those carry the assistant's reply token by token. They belong in the
 *   transcript, and a log that repeated them would be unreadable.
 * - `queue_state`, which restates the queue on every transition and is
 *   already on screen above the composer.
 *
 * What is left is the set V1's panel showed: session and sandbox lifecycle,
 * thread starts, tool calls, turn boundaries, and errors.
 */
import type { EngineEvent, StoredBusEvent } from "@valet/engine";
import type { SessionLogEntry, SessionLogKind } from "../wire/types.js";

/**
 * Event types the log renders, mapped to the kind that drives the icon and
 * the filter chips. A type absent from this table is dropped — the engine
 * adds event types over time, and a log that renders an unknown type as
 * `[object Object]` is worse than one that omits it until somebody writes
 * its line.
 */
const LOG_KINDS: Readonly<Record<string, SessionLogKind>> = {
  sandbox_status: "lifecycle",
  status: "lifecycle",
  thread_start: "lifecycle",
  model_switched: "lifecycle",
  compaction_start: "lifecycle",
  compaction_end: "lifecycle",
  task_start: "lifecycle",
  task_end: "lifecycle",
  tool_start: "tool",
  tool_end: "tool",
  turn_end: "turn",
  submission_settled: "turn",
  decision_gate: "turn",
  decision_gate_resolved: "turn",
  decision_gate_expired: "turn",
  decision_gate_withdrawn: "turn",
  command_result: "turn",
  error: "error",
  submission_stuck: "error",
};

/** True when this event type has a line in the log. */
export function isLoggable(type: string): boolean {
  return type in LOG_KINDS;
}

/** How long a single detail line may run before it is cut. */
const MAX_DETAIL = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

/**
 * The tool argument worth showing on one line. A tool call's full arguments
 * are a JSON object; the log shows the one field that says which thing the
 * call acted on, because that is what a reader scans for.
 */
function toolSubject(args: Record<string, unknown>): string | undefined {
  for (const field of ["path", "filePath", "file", "command", "query", "url", "pattern"]) {
    const value = args[field];
    if (typeof value === "string" && value.trim() !== "") return clip(value);
  }
  return undefined;
}

/** The summary and detail lines for one engine event. */
function describe(event: EngineEvent): { summary: string; detail?: string } {
  switch (event.type) {
    case "sandbox_status":
      return {
        summary: `Sandbox ${event.state}`,
        detail: event.sandboxId ? `${event.sandboxId} (epoch ${event.epoch})` : `epoch ${event.epoch}`,
      };
    case "status":
      return { summary: `Agent ${event.status.replace(/_/g, " ")}` };
    case "thread_start":
      return {
        summary: "Thread started",
        detail: event.parentThreadId ? `branched from ${event.parentThreadId}` : undefined,
      };
    case "model_switched":
      return { summary: "Model switched", detail: `${event.fromModel} → ${event.toModel} (${event.reason})` };
    case "compaction_start":
      return { summary: "Compaction started" };
    case "compaction_end":
      return { summary: "Compaction finished" };
    case "task_start":
      return { summary: "Child session started", detail: event.childSessionId };
    case "task_end":
      return { summary: "Child session finished", detail: event.childSessionId };
    case "tool_start":
      return { summary: `Tool ${event.tool}`, detail: toolSubject(event.args) };
    case "tool_end":
      return {
        summary: `Tool ${event.tool} ${event.isError ? "failed" : "finished"}`,
        detail: event.result ? clip(event.result) : undefined,
      };
    case "turn_end": {
      const parts: string[] = [];
      if (event.model) parts.push(event.model);
      if (event.turnDurationMs !== undefined) parts.push(`${Math.round(event.turnDurationMs / 100) / 10}s`);
      if (event.usage) parts.push(`${event.usage.total} tokens`);
      return {
        summary: `Turn ended (${event.reason.replace(/_/g, " ")})`,
        detail: parts.length > 0 ? parts.join(" · ") : undefined,
      };
    }
    case "submission_settled":
      return {
        summary: `Message ${event.outcome.outcome}`,
        detail: event.outcome.error ? clip(event.outcome.error) : undefined,
      };
    case "decision_gate":
      return { summary: "Waiting for approval", detail: clip(event.gate.title) };
    case "decision_gate_resolved":
      return { summary: "Approval resolved", detail: event.resolution.actionId };
    case "decision_gate_expired":
      return { summary: "Approval expired" };
    case "decision_gate_withdrawn":
      return { summary: "Approval withdrawn", detail: event.reason };
    case "command_result":
      // `entry.command` is the command as the user typed it, leading slash
      // included, so it needs no prefix of ours.
      return { summary: `Command ${clip(event.entry.command)}`, detail: event.entry.ok ? undefined : "failed" };
    case "error":
      return { summary: `Error ${event.code}`, detail: clip(event.error) };
    case "submission_stuck":
      return {
        summary: "Message is stuck",
        detail: `${event.attemptCount} attempts over ${Math.round(event.ageMs / 60_000)} minutes`,
      };
    default:
      // Every type in LOG_KINDS has a case above. This is the guard for a
      // type added to the table and not to the switch.
      return { summary: event.type.replace(/_/g, " ") };
  }
}

/**
 * Projects one stored engine event into a log row, or `null` when the event
 * has no line in the log.
 */
export function toLogEntry(stored: StoredBusEvent): SessionLogEntry | null {
  const kind = LOG_KINDS[stored.event.type];
  if (!kind) return null;
  const { summary, detail } = describe(stored.event);
  return {
    offset: stored.offset,
    type: stored.event.type,
    kind,
    summary,
    ...(detail !== undefined && detail !== "" ? { detail } : {}),
    ...(stored.threadId !== undefined ? { threadId: stored.threadId } : {}),
    at: stored.timestamp,
  };
}

/**
 * Projects a page of stored events. Order is preserved — the event stream
 * already returns them oldest first, which is reading order for a log.
 */
export function toLogEntries(stored: readonly StoredBusEvent[]): SessionLogEntry[] {
  const out: SessionLogEntry[] = [];
  for (const event of stored) {
    const entry = toLogEntry(event);
    if (entry) out.push(entry);
  }
  return out;
}
