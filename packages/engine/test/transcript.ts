import { getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai/compat";

/** Return the complete system prompt from a normalized provider transcript. */
export function transcriptSystemPrompt(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === "system")
    .map(getSystemMessageText)
    .join("\n\n");
}
