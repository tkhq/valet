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
  save: (text: string) => Promise<string | undefined>;
}

/**
 * Keep a tool result inside the cap. The result text and its text
 * attachments count together. A result over `maxChars` characters or
 * `maxTokens` estimated tokens is saved whole by `save`, with its text
 * attachments folded in, and the model gets a preview and the file path.
 * When `save` fails, the model gets the first part only and a note that
 * the rest was dropped.
 */
export async function capToolResult(result: ToolResult, opts: ToolResultCapOptions): Promise<ToolResult> {
  const textAttachments = (result.attachments ?? []).filter((a): a is Extract<ToolAttachment, { type: "text" }> => a.type === "text");
  const text = [result.text ?? "", ...textAttachments.map(textAttachmentText)].filter(Boolean).join("\n");
  if (!text) return result;
  const tokens = estimateResultTokens(text);
  if (text.length <= opts.maxChars && tokens <= opts.maxTokens) return result;
  const rest = result.attachments?.filter((a) => a.type !== "text");
  const base: ToolResult = { ...result, ...(result.attachments ? { attachments: rest } : {}) };
  const size = `${text.length} characters, about ${tokens} tokens`;
  let path: string | undefined;
  try {
    path = await opts.save(text);
  } catch {
    path = undefined;
  }
  if (path !== undefined) {
    return {
      ...base,
      text:
        `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n\n` +
        `[${opts.toolName} output too large (${size}). The full output is saved in the working directory at ${path}. ` +
        "Read it with read and offset, or search it with grep. The first part is shown above.]",
    };
  }
  // A fair share of the cap when the result is dense, so the kept part also fits.
  const keep = Math.min(opts.maxChars, Math.floor(text.length * (opts.maxTokens / tokens)));
  return {
    ...base,
    text:
      `${text.slice(0, keep)}\n\n` +
      `[${opts.toolName} output too large (${size}), and it could not be saved. Only the first ${keep} characters are shown; ` +
      "the rest was dropped. If the tool can page or filter its results, call it again for the part you need.]",
  };
}

/**
 * Keep a thrown tool error inside the cap. pi-agent-core puts a thrown
 * error's message into context as the tool result, so a long message gets
 * the same preview and saved file as a long result. A message inside the cap
 * returns the same error unchanged.
 */
export async function capToolError(err: unknown, opts: ToolResultCapOptions): Promise<unknown> {
  if (!(err instanceof Error)) return err;
  const capped = await capToolResult({ text: err.message }, opts);
  return capped.text === err.message ? err : new Error(capped.text, { cause: err });
}
