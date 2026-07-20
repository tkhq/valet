/**
 * Final-assistant-reply selection shared by the `session` and `orchestrator`
 * node executors.
 *
 * A waited node's output comes from the transcript's last assistant message.
 * That message is not always a usable reply: the runner finalizes failed
 * turns as assistant messages with empty content plus an `error` part and a
 * `finish` part with reason `"error"`. Feeding those (or a transcript with no
 * assistant message at all) into the structured-output repair pipeline
 * fabricates schema-shaped blank values and reports success — so callers use
 * this classification to fail the node loudly instead.
 */

// Two extra transcript reads, 5s apart, when a successful wait hasn't yet
// produced a finalized assistant reply. Covers the boot-window false-idle
// (poll observes idle before the prompt is processed) and DO→D1 flush lag
// without turning either into a spurious hard failure.
export const REPLY_REFETCH_ATTEMPTS = 3;
export const REPLY_REFETCH_DELAY_MS = 5_000;

export interface AssistantReplyCandidate {
  role: string;
  content: string;
  parts?: unknown;
}

export type AssistantReplyResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: 'no_assistant_reply'; error?: undefined }
  | { ok: false; reason: 'turn_error'; error: string };

/**
 * True when re-reading a lagging transcript could still change the outcome:
 * either no assistant message has landed yet, or the last one has no `finish`
 * part (turn still streaming / not yet finalized). Turn errors are final.
 * Callers that exhaust their retries still apply the normal classification —
 * a finish-less message is ultimately accepted, matching pre-retry behavior.
 */
export function replyMayStillArrive<T extends AssistantReplyCandidate>(
  result: AssistantReplyResult<T>,
): boolean {
  if (!result.ok) return result.reason === 'no_assistant_reply';
  const parts = Array.isArray(result.message.parts)
    ? (result.message.parts as Array<Record<string, unknown>>)
    : [];
  return !parts.some((p) => p != null && p['type'] === 'finish');
}

export function pickFinalAssistantReply<T extends AssistantReplyCandidate>(
  messages: T[],
): AssistantReplyResult<T> {
  let last: T | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      last = messages[i];
      break;
    }
  }
  if (!last) return { ok: false, reason: 'no_assistant_reply' };

  const parts = Array.isArray(last.parts) ? (last.parts as Array<Record<string, unknown>>) : [];
  const errorPart = parts.find((p) => p != null && p['type'] === 'error');
  const finishPart = parts.find((p) => p != null && p['type'] === 'finish');
  if (errorPart !== undefined || (finishPart !== undefined && finishPart['reason'] === 'error')) {
    const message = typeof errorPart?.['message'] === 'string' && errorPart['message'].length > 0
      ? errorPart['message']
      : 'the agent turn ended with an error';
    return { ok: false, reason: 'turn_error', error: message };
  }
  // A canceled turn's text is whatever streamed before the abort — never a
  // trustworthy reply, and schema repair would happily fill a schema from it.
  if (finishPart !== undefined && finishPart['reason'] === 'canceled') {
    return { ok: false, reason: 'turn_error', error: 'the agent turn was canceled before completing' };
  }
  return { ok: true, message: last };
}
