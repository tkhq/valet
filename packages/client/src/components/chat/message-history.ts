/**
 * Terminal-style recall of previously sent prompts in the composer.
 *
 * The composer walks a list of the user's own messages, most recent first. An
 * index of `null` means the user is on their live draft rather than in the
 * history; every other index points into the history list, which is ordered
 * oldest to newest.
 */

interface HistoryMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

/**
 * Prompts that mention files are sent with the file contents inlined ahead of
 * the typed text. Recalling the inlined copy would flood the composer with file
 * bodies, so the blocks come back off to leave what the user actually typed.
 */
export function stripFileContextBlocks(content: string): string {
  return content.replace(/<file path="[^"]*">[\s\S]*?<\/file>\s*/g, '').trimStart();
}

/**
 * Builds the recall list from the messages of the current thread: the user's
 * own prompts, oldest first, without the file contents the composer inlined and
 * without immediate repeats of the same prompt.
 */
export function getUserMessageHistory(messages: readonly HistoryMessage[]): string[] {
  const history: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user') continue;

    const content = stripFileContextBlocks(message.content ?? '').trim();
    if (!content) continue;
    if (history[history.length - 1] === content) continue;

    history.push(content);
  }

  return history;
}

/**
 * Whether ArrowUp should recall history rather than move the caret. Recall only
 * takes over at the very start of the composer, so arrowing through a draft
 * that spans several lines keeps working normally.
 */
export function canRecallHistory(value: string, cursorPos: number): boolean {
  return value.length === 0 || cursorPos === 0;
}

/** Steps one prompt further back, stopping at the oldest. */
export function recallPrevIndex(history: readonly string[], index: number | null): number | null {
  if (history.length === 0) return null;
  if (index === null) return history.length - 1;
  return Math.max(0, index - 1);
}

/** Steps one prompt forward, returning to the draft once past the newest. */
export function recallNextIndex(history: readonly string[], index: number | null): number | null {
  if (index === null) return null;
  if (index >= history.length - 1) return null;
  return index + 1;
}

/** The composer text for a recall position; the draft stands in for `null`. */
export function valueForRecallIndex(
  history: readonly string[],
  index: number | null,
  draft: string,
): string {
  if (index === null) return draft;
  return history[index] ?? draft;
}
