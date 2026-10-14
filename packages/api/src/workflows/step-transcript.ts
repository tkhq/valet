import type { MessagePart, SessionEntry, SessionStore } from "@valet/engine";

/**
 * One message of a workflow step's conversation, sized for an agent's
 * context. A `session` step has no app session row, so the chat routes
 * cannot read it; this reads the engine store directly and never builds
 * the session.
 */
export interface StepTranscriptMessage {
  index: number;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  textTruncated?: true;
  stopReason?: string;
  toolCalls?: StepToolCall[];
}

export interface StepToolCall {
  tool: string;
  status: string;
  args?: string;
  result?: string;
  error?: string;
}

const TEXT_CHARS = 6_000;
const TOOL_CHARS = 1_500;

/**
 * The step's messages, oldest first. `before` pages back from a message
 * index, and `limit` bounds the page. Null when the session or thread does
 * not exist.
 */
export async function readStepTranscript(
  store: SessionStore,
  sessionId: string,
  threadId: string | undefined,
  page: { before?: number; limit: number },
): Promise<{ threadId: string; total: number; messages: StepTranscriptMessage[] } | null> {
  const thread = threadId ?? (await store.listThreads(sessionId))[0]?.id;
  if (!thread) return null;
  const snapshot = await store.getThreadSnapshot(sessionId, thread);
  if (!snapshot) return null;
  const all = snapshot.entries.flatMap((entry, index) => toMessage(entry, index));
  const end = Math.min(page.before ?? all.length, all.length);
  return { threadId: thread, total: all.length, messages: all.slice(Math.max(0, end - page.limit), end) };
}

function toMessage(entry: SessionEntry, index: number): StepTranscriptMessage[] {
  if (entry.type === "compaction") return [{ index, role: "system", text: "[Earlier context was compacted here.]" }];
  if (entry.type !== "message") return [];
  const text = (entry.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n") || entry.content;
  const toolCalls = (entry.parts ?? []).flatMap((part) => part.type === "tool_call" ? [toolCall(part)] : []);
  return [{
    index,
    role: entry.role,
    ...(text ? clip(text, TEXT_CHARS) : {}),
    ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }];
}

function toolCall(part: Extract<MessagePart, { type: "tool_call" }>): StepToolCall {
  const result = resultText(part.result);
  return {
    tool: part.toolName,
    status: part.status,
    ...(part.args !== undefined ? { args: cap(JSON.stringify(part.args) ?? "", TOOL_CHARS) } : {}),
    ...(result ? { result: cap(result, TOOL_CHARS) } : {}),
    ...(part.error ? { error: cap(part.error, TOOL_CHARS) } : {}),
  };
}

/** Tool results arrive as `{ text }`, `{ content: [{ type: "text", text }] }`,
 * or a bare string; anything else is shown as JSON. */
function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    if ("text" in result && typeof result.text === "string") return result.text;
    if ("content" in result && Array.isArray(result.content)) {
      const texts = result.content.flatMap((item: unknown) =>
        item && typeof item === "object" && "text" in item && typeof item.text === "string" ? [item.text] : []);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return JSON.stringify(result) ?? "";
}

function clip(text: string, max: number): { text: string; textTruncated?: true } {
  return text.length <= max ? { text } : { text: text.slice(0, max), textTruncated: true };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
