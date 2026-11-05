import type { StreamMessage } from "~/stores/stream";

/**
 * The reply ends with a finished tool call, such as a brief, a started task,
 * or a message sent to a child. An empty reply after it is the model saying
 * nothing more, not a failed turn. A failed turn still names its error.
 */
export function endsWithToolResult(message: StreamMessage | undefined): boolean {
  const last = message?.role === "assistant" ? message.parts.at(-1) : undefined;
  return last?.kind === "tool_call" && last.status === "completed";
}
