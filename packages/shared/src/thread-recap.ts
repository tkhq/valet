/**
 * When a thread shows a recap to the person who opens it, and which
 * messages it covers. The web view and the API use the same rule, so the
 * view can place the "new" line before the API has written the recap.
 */

/** The message fields the rule reads. The wire `Message` satisfies it. */
export interface RecapMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  author?: { id: string; name?: string; externalSender?: boolean };
  signal?: unknown;
  command?: unknown;
  compaction?: unknown;
}

export interface RecapWindow<M extends RecapMessage = RecapMessage> {
  /** "away": the reader was here before. "first": the reader never opened or wrote in the thread. */
  mode: "away" | "first";
  /** The reader's last visit or own message. Absent for "first". */
  since?: number;
  /** The conversation messages the recap covers, oldest first. */
  messages: M[];
  /** Messages before the window, oldest first. The recap reads them as context only. */
  earlier: M[];
  /** Names of the other people who wrote in the window. */
  people: string[];
  /** False when the window is short enough to read at a glance: show the "new" line only. */
  worthRecap: boolean;
}

/** A window shorter than both limits reads in one screen. */
export const RECAP_MIN_MESSAGES = 4;
export const RECAP_MIN_CHARS = 1_200;

/** A person's message: a user entry with an author that is not a team or org API key. */
function personMessage(message: RecapMessage): boolean {
  const id = message.author?.id;
  return message.role === "user" && !!id && !id.startsWith("team:") && !id.startsWith("org:");
}

/** A person other than the reader wrote it. A channel sender with no account runs as a member, so it never counts as the reader. */
export function writtenByOtherPerson(message: RecapMessage, readerId: string): boolean {
  return personMessage(message) && (message.author?.id !== readerId || message.author?.externalSender === true);
}

function writtenByReader(message: RecapMessage, readerId: string): boolean {
  return personMessage(message) && message.author?.id === readerId && message.author?.externalSender !== true;
}

/** User and assistant text only: signals, command results, and compaction markers are not conversation. */
function conversation<M extends RecapMessage>(messages: M[]): M[] {
  return messages.filter((message) => (message.role === "user" || message.role === "assistant")
    && !message.signal && !message.command && !message.compaction && message.content.trim().length > 0);
}

/**
 * The window a recap covers for `readerId`, or null when the thread shows
 * none. A recap shows only when another person wrote to Valet since the
 * reader's last visit (`readAt`) or own message. A reader who never opened
 * or wrote in the thread gets the whole thread, when another person wrote in it.
 */
export function recapWindow<M extends RecapMessage>(messages: M[], readerId: string, readAt?: number): RecapWindow<M> | null {
  const talk = conversation(messages);
  const ownAt = talk.reduce((latest, message) => writtenByReader(message, readerId) ? Math.max(latest, message.createdAt) : latest, 0);
  const since = Math.max(readAt ?? 0, ownAt);
  const start = since > 0 ? talk.findIndex((message) => message.createdAt > since) : 0;
  if (start < 0) return null;
  const window = talk.slice(start);
  const others = window.filter((message) => writtenByOtherPerson(message, readerId));
  if (others.length === 0) return null;
  const chars = window.reduce((total, message) => total + message.content.length, 0);
  return {
    mode: since > 0 ? "away" : "first",
    ...(since > 0 ? { since } : {}),
    messages: window,
    earlier: talk.slice(0, start),
    people: [...new Set(others.map((message) => message.author?.name?.trim() || "A teammate"))],
    worthRecap: window.length >= RECAP_MIN_MESSAGES || chars >= RECAP_MIN_CHARS,
  };
}
