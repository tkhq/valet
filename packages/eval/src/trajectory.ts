/**
 * Trajectory extraction (TKAI-329): turn persisted engine entries into a
 * `Trajectory` — the ordered record of what the agent did.
 *
 * Borrow of tests/smoke/tool-trace.ts, adapted to engine `SessionEntry`
 * parts (the smoke helper reads wire messages). Tool calls come from
 * `tool_call` parts on assistant message entries; per-turn usage and cost
 * come from the entry fields the engine stamps at message_end.
 */
import type { MessageCost, MessageEntry, MessageUsage, SessionEntry } from "@valet/engine";
import type { Trajectory, TrajectoryToolCall, TrajectoryTurn } from "./types.js";

/**
 * Extract readable text from a persisted tool_call `result` of any shape:
 * the engine's `{ text }`, pi-agent-core's `{ content: [{ type: "text",
 * text }] }`, or a bare string. Returns "" when no text is reachable.
 */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";
  const r = result as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  if (Array.isArray(r.content)) {
    return r.content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function isAssistantMessage(e: SessionEntry): e is MessageEntry {
  return e.type === "message" && e.role === "assistant";
}

function addUsage(sum: MessageUsage, u: MessageUsage): void {
  sum.input += u.input;
  sum.output += u.output;
  sum.cacheRead += u.cacheRead;
  sum.cacheWrite += u.cacheWrite;
  sum.total += u.total;
}

function addCost(sum: MessageCost, c: MessageCost): void {
  sum.input += c.input;
  sum.output += c.output;
  sum.cacheRead += c.cacheRead;
  sum.cacheWrite += c.cacheWrite;
  sum.total += c.total;
}

export interface ExtractTrajectoryInput {
  caseId: string;
  /** The first user turn's content. */
  prompt: string;
  /** Model spec the case ran with. */
  model: string;
  durationMs: number;
  /** Entries in store order for one thread. */
  entries: SessionEntry[];
  metadata?: Record<string, unknown>;
  children?: Trajectory[];
}

/** Build a `Trajectory` from one thread's persisted entries. */
export function extractTrajectory(input: ExtractTrajectoryInput): Trajectory {
  const toolCalls: TrajectoryToolCall[] = [];
  const turns: TrajectoryTurn[] = [];
  const usage: MessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost: MessageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let anyCost = false;
  let finalOutput = "";
  let stopReason: string | undefined;
  let toolIndex = 0;

  for (const entry of input.entries) {
    if (!isAssistantMessage(entry)) continue;

    const turn: TrajectoryTurn = { index: turns.length };
    if (entry.usage) {
      turn.usage = entry.usage;
      addUsage(usage, entry.usage);
    }
    if (entry.cost) {
      turn.cost = entry.cost;
      addCost(cost, entry.cost);
      anyCost = true;
    }
    turns.push(turn);

    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call") continue;
      toolCalls.push({
        toolName: part.toolName,
        callId: part.callId,
        status: part.status,
        ...(part.args !== undefined ? { args: part.args } : {}),
        ...(part.result !== undefined ? { result: part.result } : {}),
        ...(part.error !== undefined ? { error: part.error } : {}),
        index: toolIndex++,
      });
    }

    if (entry.content.length > 0) finalOutput = entry.content;
    if (entry.stopReason !== undefined) stopReason = entry.stopReason;
  }

  return {
    caseId: input.caseId,
    prompt: input.prompt,
    model: input.model,
    turns,
    toolCalls,
    finalOutput,
    usage,
    ...(anyCost ? { cost } : {}),
    durationMs: input.durationMs,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.children !== undefined && input.children.length > 0 ? { children: input.children } : {}),
  };
}
