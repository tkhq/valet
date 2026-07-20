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

export interface AssistantReplyCandidate {
  role: string;
  content: string;
  parts?: unknown;
}

export type AssistantReplyResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: 'no_assistant_reply'; error?: undefined }
  | { ok: false; reason: 'turn_error'; error: string };

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
  return { ok: true, message: last };
}
