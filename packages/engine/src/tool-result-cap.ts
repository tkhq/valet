import { textAttachmentText } from "./tool-bridge.js";
import type { ToolAttachment, ToolResult } from "./types.js";

/**
 * Most characters of one tool result that go into the model's context.
 * Claude Code saves a larger result to a file and sends a preview
 * (`maxResultSizeChars`, 100,000 for most tools).
 */
export const TOOL_RESULT_MAX_CHARS = 100_000;

/**
 * Most estimated tokens of one tool result. Claude Code caps an MCP tool's
 * output at 25,000 tokens. With JSON at 2 characters per token
 * (`estimateResultTokens`), this cuts a JSON result at about 50,000
 * characters.
 */
export const TOOL_RESULT_MAX_TOKENS = 25_000;

/**
 * Token estimate for a tool result: 4 characters per token, or 2 for JSON,
 * as Claude Code estimates file reads. Measured with the Anthropic
 * tokenizer, JSON runs about 2.0 characters per token. Compaction keeps its
 * own 4-character estimate (`estimateTokens`).
 */
export function estimateResultTokens(text: string): number {
  const first = /\S/.exec(text.slice(0, 64))?.[0];
  return Math.ceil(text.length / (first === "{" || first === "[" ? 2 : 4));
}

/** Characters of a saved result that the model sees. Claude Code shows the
 * first 2 KB. */
export const TOOL_RESULT_PREVIEW_CHARS = 2_000;

export interface ToolResultCapOptions {
  toolName: string;
  maxChars: number;
  maxTokens: number;
  /** "head-tail" keeps the last part too, for output whose end carries the
   * outcome (`ToolDef.resultPreview`). */
  preview?: "head" | "head-tail";
  /** Save the whole text and return its path, or undefined when the session
   * cannot save it or could not read it back. */
  save: (text: string) => Promise<string | undefined>;
}

/** The first `size` characters, or the first and last halves of `size` with
 * a marker between them for "head-tail". */
function excerpt(text: string, size: number, preview: "head" | "head-tail", note: string): string {
  if (preview === "head") return `${text.slice(0, size)}\n\n${note}`;
  const half = Math.floor(size / 2);
  // The note sits between the two parts, so the text still ends with the
  // tool's own last line, such as bash's exit status.
  return `${text.slice(0, half)}\n\n${note}\n\n${text.slice(-half)}`;
}

/**
 * Keep a tool result inside the cap. The result text and its text
 * attachments count together. A result over `maxChars` characters or
 * `maxTokens` estimated tokens is saved by `save`, with its text attachments
 * folded in, and the model gets a preview and the file path. When `save`
 * returns no path, the model gets as much as the cap allows and a note that
 * the rest was dropped. Either way the whole text rides in `fullText`, which
 * the UI loads and the model never sees.
 */
export async function capToolResult(result: ToolResult, opts: ToolResultCapOptions): Promise<ToolResult> {
  const textAttachments = (result.attachments ?? []).filter((a): a is Extract<ToolAttachment, { type: "text" }> => a.type === "text");
  const text = [result.text ?? "", ...textAttachments.map(textAttachmentText)].filter(Boolean).join("\n");
  if (!text) return result;
  const tokens = estimateResultTokens(text);
  if (text.length <= opts.maxChars && tokens <= opts.maxTokens) return result;
  const preview = opts.preview ?? "head";
  const rest = result.attachments?.filter((a) => a.type !== "text");
  const base: ToolResult = { ...result, ...(result.attachments ? { attachments: rest } : {}), fullText: text };
  const size = `${text.length} characters, about ${tokens} tokens`;
  let path: string | undefined;
  try {
    path = await opts.save(text);
  } catch {
    path = undefined;
  }
  const shown = preview === "head" ? "The first part is shown above." : "The first and last parts are shown.";
  if (path !== undefined) {
    const note = `[${opts.toolName} output too large (${size}). It is saved in the working directory at ${path}. ` +
      `Read it with read and offset, or search it with grep. ${shown}]`;
    return { ...base, text: excerpt(text, TOOL_RESULT_PREVIEW_CHARS, preview, note) };
  }
  // A fair share of the cap when the result is dense, so the kept part also fits.
  const keep = Math.min(opts.maxChars, Math.floor(text.length * (opts.maxTokens / tokens)));
  const note = `[${opts.toolName} output too large (${size}), and it is not saved to a file. Only ${keep} characters are shown; ` +
    `the rest was dropped. ${shown} If the tool can page or filter its results, call it again for the part you need.]`;
  return { ...base, text: excerpt(text, keep, preview, note) };
}

/**
 * Keep a thrown tool error inside the cap. pi-agent-core puts a thrown
 * error's message into context as the tool result (`String(error)` for a
 * non-Error), so a long message gets the same preview and saved file as a
 * long result. A message inside the cap returns the same value unchanged.
 */
export async function capToolError(err: unknown, opts: ToolResultCapOptions): Promise<unknown> {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (message === undefined) return err;
  const capped = await capToolResult({ text: message }, opts);
  return capped.text === message ? err : new Error(capped.text, { cause: err });
}
