import { MESSAGE_TURN_ERROR_KEY, readModelResponseMetadata, type MessageUsage, type MessagePart, type SessionEntry, type SessionStore } from "@valet/engine";

/**
 * One message of a workflow step's conversation, sized for an agent's
 * context. A `session` step has no app session row, so the chat routes
 * cannot read it; this reads the engine store directly and never builds
 * the session.
 */
export interface StepTranscriptMessage {
  index: number;
  messageId?: string;
  queueItemId?: string;
  createdAt?: number;
  model?: string;
  textLength?: number;
  providerError?: string;
  usage?: MessageUsage;
  modelResponse?: ReturnType<typeof readModelResponseMetadata>;
  synthetic?: true;
  compactionContinuation?: true;
  compaction?: { tokenCountBefore: number; tokenCountAfter: number; coveredEntryCount: number };
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  textTruncated?: true;
  stopReason?: string;
  toolCalls?: StepToolCall[];
}

export interface TranscriptContentRequest {
  messageId: string;
  field: "text" | "tool_args" | "tool_result" | "tool_error";
  callId?: string;
  offset: number;
}

interface TranscriptContentSlice extends TranscriptContentRequest {
  text: string;
  totalLength: number;
  nextOffset: number | null;
}

export interface StepToolCall {
  callId: string;
  argsTruncated?: true;
  resultTruncated?: true;
  errorTruncated?: true;
  tool: string;
  status: string;
  args?: string;
  result?: string;
  error?: string;
}

const TEXT_CHARS = 6_000;
const TOOL_CHARS = 1_500;

/** The most entries one read loads per submission. A step that exceeds it
 * shows its latest entries. */
const ENTRY_CAP = 2_000;

/**
 * The step's messages, oldest first. `index` counts messages only, so
 * `before` pages back from any message's index, and `limit` bounds the
 * page. `queueItemIds` keeps those submissions' entries, in order, for a step
 * that shares its thread with other steps. Each read is bounded by the store
 * and takes no thread lock. Null when the session or thread does not exist.
 */
export async function readStepTranscript(
  store: SessionStore,
  sessionId: string,
  threadId: string | undefined,
  page: { before?: number; limit: number; queueItemIds?: string[]; content?: TranscriptContentRequest },
): Promise<{ threadId: string; total: number; messages: StepTranscriptMessage[]; content?: TranscriptContentSlice; contentError?: string; entriesMayBeTruncated: boolean } | null> {
  const thread = threadId ? await store.getThread(sessionId, threadId) : (await store.listThreads(sessionId))[0];
  if (!thread) return null;
  const reads = page.queueItemIds?.length ? page.queueItemIds.map((queueItemId) => ({ queueItemId })) : [{}];
  const batches = await Promise.all(reads.map((filter) => store.getEntries(sessionId, thread.id, { limit: ENTRY_CAP, ...filter })));
  const entries = batches.flat();
  const content = page.content ? readContent(entries, page.content) : undefined;
  const all = entries.flatMap(toMessage).map((message, index) => ({ index, ...message }));
  const end = Math.min(Math.max(page.before ?? all.length, 0), all.length);
  return { threadId: thread.id, total: all.length, messages: all.slice(Math.max(0, end - page.limit), end),
    entriesMayBeTruncated: batches.some(batch => batch.length >= ENTRY_CAP),
    ...(content ? { content } : page.content ? { contentError: "Content not found in this step’s retained entries. Check message_id, content_field and call_id." } : {}),
  };
}

function toMessage(entry: SessionEntry): Omit<StepTranscriptMessage, "index">[] {
  if (entry.type === "compaction") return [{ role: "system", messageId: entry.id, createdAt: entry.createdAt, textLength: entry.summary.length,
    ...clip(entry.summary, TEXT_CHARS), compaction: { tokenCountBefore: entry.tokenCountBefore, tokenCountAfter: entry.tokenCountAfter, coveredEntryCount: entry.coveredEntryIds.length } }];
  if (entry.type !== "message") return [];
  const text = (entry.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n") || entry.content;
  const toolCalls = (entry.parts ?? []).flatMap((part) => part.type === "tool_call" ? [toolCall(part)] : []);
  return [{
    role: entry.role,
    messageId: entry.id,
    queueItemId: entry.queueItemId,
    createdAt: entry.createdAt,
    model: entry.model,
    usage: entry.usage,
    modelResponse: readModelResponseMetadata(entry),
    ...(entry.metadata?.synthetic === true ? { synthetic: true as const } : {}),
    ...(entry.metadata?.compaction_continue === true ? { compactionContinuation: true as const } : {}),
    textLength: entry.content.length,
    ...(typeof entry.metadata?.[MESSAGE_TURN_ERROR_KEY] === "string"
      ? { providerError: cap(entry.metadata[MESSAGE_TURN_ERROR_KEY], TOOL_CHARS) } : {}),
    ...(text ? clip(text, TEXT_CHARS) : {}),
    ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }];
}

function toolCall(part: Extract<MessagePart, { type: "tool_call" }>): StepToolCall {
  const result = resultText(part.result);
  return {
    tool: part.toolName,
    callId: part.callId,
    ...((JSON.stringify(part.args) ?? "").length > TOOL_CHARS ? { argsTruncated: true as const } : {}),
    ...(result.length > TOOL_CHARS ? { resultTruncated: true as const } : {}),
    ...(part.error && part.error.length > TOOL_CHARS ? { errorTruncated: true as const } : {}),
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

/** Only looks inside the already-authorized step entries, including submission filters. */
function readContent(entries: SessionEntry[], request: TranscriptContentRequest): TranscriptContentSlice | undefined {
  const entry = entries.find(entry => entry.id === request.messageId);
  let text: string | undefined;
  if (request.field === "text") {
    if (entry?.type === "compaction") text = entry.summary;
    if (entry?.type === "message") text = (entry.parts ?? []).filter(part => part.type === "text").map(part => part.text).join("\n") || entry.content;
  } else if (entry?.type === "message" && request.callId) {
    const part = entry.parts?.find(part => part.type === "tool_call" && part.callId === request.callId);
    if (part?.type === "tool_call") {
      text = request.field === "tool_args" ? JSON.stringify(part.args) : request.field === "tool_result" ? resultText(part.result) : part.error;
    }
  }
  if (text === undefined) return undefined;
  const offset = Number.isFinite(request.offset) ? Math.min(Math.max(Math.trunc(request.offset), 0), text.length) : 0;
  const end = Math.min(offset + TEXT_CHARS, text.length);
  return { ...request, offset, text: text.slice(offset, end), totalLength: text.length, nextOffset: end < text.length ? end : null };
}
