/**
 * Trims large tool output in the REST transcript. A thread opens with its
 * recent messages, and most of their bytes are a few large tool results
 * (logs, file reads, API dumps) inside collapsed steps. The transcript ships
 * the start and the end of each large result; the web loads the full result
 * when a step's card opens (`GET /api/threads/:id/tool-output`). The live
 * socket and the engine's stored entries are unchanged.
 */
import type { MessagePart } from "../wire/types.js";

/** Results at or under this many characters ship whole. */
export const TRIM_ABOVE_CHARS = 16_384;
const HEAD_CHARS = 6_000;
/** Command output usually ends with the error or the summary. */
const TAIL_CHARS = 2_000;

/** The printable text of a stored tool result, in the shapes the engine has persisted. */
function resultTextOf(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (!Array.isArray(record.content)) return undefined;
  let text = "";
  for (const block of record.content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

function trimmedText(text: string): string {
  const hidden = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n\n[${Math.ceil(hidden / 1024)} KB of output not shown. Open the step to load all of it.]\n\n${text.slice(-TAIL_CHARS)}`;
}

/** The result with its text replaced, in the result's own shape. */
function withText(result: unknown, text: string): unknown {
  if (typeof result === "string") return text;
  const record = result as Record<string, unknown>;
  // Keep small structured fields (`ok`, `outcome`, `approval`); drop the rest of the bulk.
  const details = record.details && typeof record.details === "object" ? { details: record.details } : {};
  if (typeof record.text === "string") return { text, ...details };
  return { content: [{ type: "text", text }], ...details };
}

/**
 * The transcript form of one entry's parts: every tool result over the limit
 * is trimmed and marked with the entry that holds the full result.
 */
/** The whole text the engine kept for a capped result (`details.fullText`,
 * from `capToolResult`). The model saw a preview; the UI can load this. */
function fullTextOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const full = (details as { fullText?: unknown }).fullText;
  return typeof full === "string" ? full : undefined;
}

function withoutFullText(result: unknown): unknown {
  const record = result as Record<string, unknown>;
  const { fullText: _full, ...details } = record.details as Record<string, unknown>;
  return { ...record, details };
}

/**
 * The result the tool-output route returns: for a capped result, its whole
 * text in place of the preview the model saw.
 */
export function fullToolResult(result: unknown): unknown {
  const full = fullTextOf(result);
  if (full === undefined) return result;
  return withText(withoutFullText(result), full);
}

export function trimToolResults(parts: MessagePart[], at: { entryId: string; threadId: string }): MessagePart[] {
  return parts.map((part) => {
    if (part.kind !== "tool_call" || part.result === undefined) return part;
    // A capped result already shows its preview. Ship that, not the stored
    // whole text, and let the step load the rest.
    const full = fullTextOf(part.result);
    if (full !== undefined) return { ...part, result: withoutFullText(part.result), resultTrimmed: { chars: full.length, ...at } };
    const text = resultTextOf(part.result);
    if (text === undefined || text.length <= TRIM_ABOVE_CHARS) return part;
    return { ...part, result: withText(part.result, trimmedText(text)), resultTrimmed: { chars: text.length, ...at } };
  });
}
