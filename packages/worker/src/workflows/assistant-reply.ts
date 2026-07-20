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

import type { WorkflowStep } from 'cloudflare:workers';

// Two extra transcript reads, 5s apart, when a strict wait hasn't yet
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

function messageParts(message: AssistantReplyCandidate): Array<Record<string, unknown>> | null {
  return Array.isArray(message.parts) ? (message.parts as Array<Record<string, unknown>>) : null;
}

/**
 * True when the message's turn reached a terminal state. Messages without a
 * parts array (legacy-format transcripts) are treated as finalized — they
 * predate streaming parts and will never gain a `finish` part.
 */
export function replyIsFinalized(message: AssistantReplyCandidate): boolean {
  const parts = messageParts(message);
  if (parts === null) return true;
  return parts.some((p) => p != null && p['type'] === 'finish');
}

/**
 * True when re-reading a lagging transcript could still change the outcome:
 * either no assistant message has landed yet, or the last one is not yet
 * finalized (turn still streaming). Turn errors are final.
 */
export function replyMayStillArrive<T extends AssistantReplyCandidate>(
  result: AssistantReplyResult<T>,
): boolean {
  if (!result.ok) return result.reason === 'no_assistant_reply';
  return !replyIsFinalized(result.message);
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

  const parts = messageParts(last) ?? [];
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

/**
 * Fetch a waited node's transcript with the lag-retry policy, shared by the
 * session and orchestrator executors.
 *
 * Attempt 0 uses `fetchKey` unchanged so executions in flight across a deploy
 * replay against their cached result; retries add a `:retry-N` suffix and a
 * durable 5s sleep. Retries run only when `strict` (the wait genuinely
 * succeeded) and the reply is still unfinalized/missing — turn errors and
 * finalized replies stop immediately.
 */
export async function fetchReplyWithRetry<T extends AssistantReplyCandidate>(opts: {
  step: WorkflowStep;
  strict: boolean;
  fetchKey: string;
  sleepKeyPrefix: string;
  fetchTranscript: () => Promise<T[]>;
  /** Optional view applied before reply picking (e.g. thread scoping). */
  scope?: (messages: T[]) => T[];
}): Promise<{ transcript: T[]; reply: AssistantReplyResult<T> }> {
  const maxAttempts = opts.strict ? REPLY_REFETCH_ATTEMPTS : 1;
  let transcript: T[] = [];
  let reply = pickFinalAssistantReply(transcript);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await opts.step.sleep(`${opts.sleepKeyPrefix}:${attempt}`, REPLY_REFETCH_DELAY_MS);
    }
    const stepKey = `${opts.fetchKey}${attempt > 0 ? `:retry-${attempt}` : ''}`;
    const json = await opts.step.do(stepKey, async () => JSON.stringify(await opts.fetchTranscript()));
    transcript = JSON.parse(json) as T[];
    reply = pickFinalAssistantReply(opts.scope ? opts.scope(transcript) : transcript);
    if (!replyMayStillArrive(reply)) break;
  }
  return { transcript, reply };
}
