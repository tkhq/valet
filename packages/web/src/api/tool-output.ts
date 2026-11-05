/** The full result of a tool call that the transcript trimmed (`GET /api/threads/:id/tool-output`). */
import { skipToken, useQuery } from "@tanstack/react-query";
import type { MessagePart } from "@valet/api/wire";
import { api } from "./client";

type Trimmed = Extract<MessagePart, { kind: "tool_call" }>["resultTrimmed"];

/** Loads only for a trimmed part. A stored result never changes, so it stays cached. */
export function useToolOutput(trimmed: Trimmed, callId: string) {
  return useQuery({
    queryKey: ["tool-output", trimmed?.threadId, trimmed?.entryId, callId],
    queryFn: trimmed ? () => api.getToolOutput(trimmed.threadId, trimmed.entryId, callId) : skipToken,
    staleTime: Infinity,
  });
}
