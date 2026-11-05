import type { StreamMessage } from "~/stores/stream";
import { isQuietCall, leadingWorkCount, type WorkPart } from "./work-group";

/** How one transcript row renders once a turn's tool calls fold together. */
export interface RowPlan {
  /** Leading parts an earlier row shows in its work line. */
  absorbedLeading: number;
  /** Quiet calls from the next messages of the turn, added to this row's last work line. */
  extraWork: WorkPart[];
  /** The agent is still adding to `extraWork`. */
  extraWorkLive: boolean;
  /** Every part of this message shows in an earlier row, so the row draws nothing. */
  hidden: boolean;
  /** How long the turn ran, on its last reply. */
  workedForMs?: number;
}

/** A turn shorter than this shows no "Worked for" line: the reader saw it happen. */
const WORKED_FOR_MIN_MS = 30_000;

/** A transcript row: a message, or a card that groups several (watch events, branch notes). */
export type PlanRow = { kind: string };
type MessageRow = { kind: "message"; message: StreamMessage };

function isMessageRow(row: PlanRow): row is MessageRow {
  return row.kind === "message" && "message" in row;
}

function message(row: PlanRow | undefined): StreamMessage | undefined {
  return row && isMessageRow(row) ? row.message : undefined;
}

/** Consecutive assistant messages from one turn share the first one's
 * header: the same model, within a few minutes, with nothing between. */
export function isContinuation(current: StreamMessage, previous: StreamMessage | undefined): boolean {
  if (!previous || current.role !== "assistant" || previous.role !== "assistant") return false;
  if (previous.compaction || previous.signal || previous.command || current.settledOutcome) return false;
  if ((current.model ?? "") !== (previous.model ?? "")) return false;
  return current.createdAt - previous.createdAt < 5 * 60_000;
}

function plainAssistant(m: StreamMessage | undefined): m is StreamMessage {
  return m !== undefined && m.role === "assistant" && !m.signal && !m.command && !m.compaction;
}

/**
 * Pure: folds each turn's tool calls into as few work lines as the text
 * allows. Each agent step is its own message, so a turn of twenty calls
 * would otherwise draw twenty lines. A message that only adds calls joins
 * the work line above it and draws nothing itself; a message with text
 * starts a new line after its text. `busy` marks the last turn as still
 * running, so it gets no "Worked for" line yet.
 */
export function planTranscript(items: readonly PlanRow[], busy: boolean): RowPlan[] {
  const plans: RowPlan[] = items.map(() => ({ absorbedLeading: 0, extraWork: [], extraWorkLive: false, hidden: false }));
  let anchor = -1;
  for (let i = 0; i < items.length; i++) {
    const m = message(items[i]);
    if (!plainAssistant(m)) { anchor = -1; continue; }
    const lead = leadingWorkCount(m.parts);
    if (anchor >= 0 && lead > 0 && isContinuation(m, message(items[i - 1]))) {
      const target = plans[anchor]!;
      target.extraWork.push(...(m.parts.slice(0, lead) as WorkPart[]));
      target.extraWorkLive = m.completed === false;
      plans[i]!.absorbedLeading = lead;
      if (lead === m.parts.length && !m.content.trim() && !m.errorMessage) {
        plans[i]!.hidden = true;
        continue;
      }
    }
    const last = m.parts.at(-1);
    anchor = last && (last.kind === "thinking" || isQuietCall(last)) ? i : -1;
  }
  markWorkedFor(items, plans, busy);
  return plans;
}

/** Puts "Worked for" on the last reply of each finished turn that used tools and took a while. */
function markWorkedFor(items: readonly PlanRow[], plans: RowPlan[], busy: boolean) {
  let start: StreamMessage | undefined;
  let lastReply = -1;
  let lastAt = 0;
  let usedTools = false;
  const close = (finished: boolean) => {
    if (start && finished && usedTools && lastReply >= 0 && lastAt - start.createdAt >= WORKED_FOR_MIN_MS) {
      plans[lastReply]!.workedForMs = lastAt - start.createdAt;
    }
  };
  for (let i = 0; i < items.length; i++) {
    const m = message(items[i]);
    if (m?.role === "user") {
      close(true);
      start = m;
      lastReply = -1;
      usedTools = false;
      continue;
    }
    if (!plainAssistant(m) || !start) continue;
    lastAt = m.createdAt;
    if (m.parts.some(part => part.kind === "tool_call")) usedTools = true;
    if (!plans[i]!.hidden) lastReply = i;
  }
  close(!busy);
}
