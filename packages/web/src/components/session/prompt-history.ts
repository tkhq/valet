import { useMemo } from "react";
import { useMe } from "~/api/settings";
import { useStreamStore, type StreamMessage } from "~/stores/stream";

/**
 * The viewer's earlier prompts in one thread, oldest first: what the
 * composer's Up and Down keys step through. A teammate's message, a channel
 * sender's message, and a signal card are not the viewer's prompts. Neither
 * is a message an agent wrote: a delegated task's brief has no author, and
 * a parent's `child_send` carries the person's id without the `interactive`
 * flag that a signed-in browser send gets. The one unauthored exception is
 * the composer's own optimistic copy of a prompt the viewer just sent. A repeat of the prompt just before it is kept
 * once.
 */
export function promptHistory(
  messages: readonly StreamMessage[],
  threadId: string | undefined,
  viewerId: string | undefined,
): string[] {
  const history: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.threadId !== threadId || message.signal) continue;
    const author = message.author;
    const own = author
      ? author.id === viewerId && !author.externalSender && author.interactive === true
      : message.persistence === "optimistic";
    if (!own) continue;
    const text = typedText(message);
    if (text && history.at(-1) !== text) history.push(text);
  }
  return history;
}

/**
 * The text to recall for one message. A skill invocation reads as a slash
 * command that runs the same skill: the server stores the expanded skill
 * body as the content and keeps the skill in `skill`. The command is the
 * `skill:<name>` form, which every organization registers; the bare name may
 * be off, or may name a built-in command instead.
 */
function typedText(message: StreamMessage): string {
  if (message.skill) {
    const args = message.skill.args?.trim();
    return args ? `/skill:${message.skill.name} ${args}` : `/skill:${message.skill.name}`;
  }
  return message.content.trim();
}

/** Where the composer stands in the history: the recalled index, or null for the person's own draft. */
export interface HistoryStep {
  index: number | null;
  text: string;
}

/**
 * One Up (`older`) or Down (`newer`) key press. Undefined means the key keeps
 * its usual caret movement. A recall never replaces text the person typed:
 * Up starts only from an empty composer, and both keys step only while the
 * composer shows a recalled prompt unchanged. Up acts on the first line and
 * Down on the last line, so the arrows still move through a long prompt.
 * Lines are the prompt's own line breaks: a prompt that only wraps on screen
 * counts as one line, so Up anywhere in it steps to an older prompt.
 * Down past the newest prompt empties the composer.
 */
export function stepHistory(
  history: readonly string[],
  current: HistoryStep,
  direction: "older" | "newer",
  caret: { start: number; end: number },
): HistoryStep | undefined {
  if (caret.start !== caret.end) return undefined;
  const recalled = current.index !== null && history[current.index] === current.text;
  if (direction === "older") {
    if (!(current.text === "" || recalled)) return undefined;
    if (current.text.lastIndexOf("\n", caret.start - 1) !== -1) return undefined;
    const index = recalled && current.index !== null ? current.index - 1 : history.length - 1;
    return index >= 0 ? { index, text: history[index] } : undefined;
  }
  if (!recalled || current.index === null) return undefined;
  if (current.text.indexOf("\n", caret.start) !== -1) return undefined;
  const index = current.index + 1;
  return index < history.length ? { index, text: history[index] } : { index: null, text: "" };
}

/** `promptHistory` for the thread the composer writes to, from the live transcript. */
export function usePromptHistory(sessionId: string, threadId: string | undefined): string[] {
  const messages = useStreamStore((s) => s.bySession?.[sessionId]?.messages);
  const viewerId = useMe().data?.id;
  return useMemo(() => promptHistory(messages ?? [], threadId, viewerId), [messages, threadId, viewerId]);
}
