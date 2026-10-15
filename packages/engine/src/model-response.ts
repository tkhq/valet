import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { MessageEntry } from "./types.js";

export const MODEL_RESPONSE_METADATA_KEY = "modelResponse";
const ID_CHARS = 200;

/** Adapted response facts only. Null means the interface did not expose the value. */
export function modelResponseMetadata(
  message: AssistantMessage,
  streamedTextLength: number,
  requestedMaxOutputTokens: number | undefined,
) {
  return {
    stopReason: message.stopReason,
    rawStopReason: message.rawStopReason?.slice(0, ID_CHARS) ?? null,
    provider: message.provider.slice(0, ID_CHARS),
    api: message.api.slice(0, ID_CHARS),
    model: message.model.slice(0, ID_CHARS),
    responseId: message.responseId?.slice(0, ID_CHARS) ?? null,
    endTurn: message.endTurn ?? null,
    blockTypes: [...new Set(message.content.map(block => block.type))],
    textLength: message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0),
    thinkingPresent: message.content.some(block => block.type === "thinking"),
    toolCallCount: message.content.filter(block => block.type === "toolCall").length,
    streamedTextLength,
    requestedMaxOutputTokens: requestedMaxOutputTokens ?? null,
    // Adapters can clamp or transform the requested limit. Do not infer the wire value.
    effectiveMaxOutputTokens: null,
    requestId: null,
    providerTerminalStatus: null,
    incompleteReason: null,
  };
}

/** Allowlist stored fields before returning diagnostics. Never forward arbitrary metadata. */
export function readModelResponseMetadata(entry: MessageEntry) {
  const value = entry.metadata?.[MODEL_RESPONSE_METADATA_KEY];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>; // Narrowed to an object above; fields are checked below.
  const blockTypes = record.blockTypes;
  const string = (key: string) => typeof record[key] === "string" ? record[key].slice(0, ID_CHARS) : null;
  const number = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0 ? record[key] : null;
  const boolean = (key: string) => typeof record[key] === "boolean" ? record[key] : null;
  return {
    stopReason: string("stopReason"), rawStopReason: string("rawStopReason"),
    provider: string("provider"), api: string("api"), model: string("model"), responseId: string("responseId"),
    endTurn: boolean("endTurn"),
    blockTypes: Array.isArray(blockTypes)
      ? ["text", "thinking", "toolCall"].filter(type => blockTypes.includes(type)) : null,
    textLength: number("textLength"), thinkingPresent: boolean("thinkingPresent"), toolCallCount: number("toolCallCount"),
    streamedTextLength: number("streamedTextLength"), requestedMaxOutputTokens: number("requestedMaxOutputTokens"),
    effectiveMaxOutputTokens: number("effectiveMaxOutputTokens"), requestId: string("requestId"),
    providerTerminalStatus: string("providerTerminalStatus"), incompleteReason: string("incompleteReason"),
  };
}
