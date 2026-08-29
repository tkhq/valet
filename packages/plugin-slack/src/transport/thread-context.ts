/**
 * Format a Slack thread's prior messages as a plain attributed transcript, to
 * hydrate an assistant's first turn in that thread. One line per message,
 * `Name: text`, oldest first. The assistant reads this instead of fetching the
 * thread itself with `read_thread`, so it starts a group conversation with full
 * context rather than the lone trigger message.
 */
import type { SlackApi } from "./api.js";
import { cleanSlackText } from "./transport.js";

/** Above this the oldest lines are dropped — a long thread would swamp the turn. */
const MAX_TRANSCRIPT_CHARS = 6000;

interface RawReply {
  user?: unknown;
  username?: unknown;
  bot_profile?: unknown;
  text?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The subset of `SlackApi` this formatter needs, so a test can supply a fake
 * without building the whole client.
 */
export type ThreadContextApi = Pick<SlackApi, "conversationsReplies" | "usersInfo">;

export async function fetchThreadTranscript(
  api: ThreadContextApi,
  opts: { channelId: string; threadTs: string; selfUserId?: string; limit?: number },
): Promise<string | null> {
  let messages: Record<string, unknown>[];
  try {
    messages = await api.conversationsReplies(opts.channelId, opts.threadTs, opts.limit ?? 100);
  } catch {
    return null; // thread gone, or the bot cannot read the channel — hydrate nothing.
  }
  // `conversations.replies` includes the trigger message itself. One message
  // means a fresh top-level mention with no prior replies — nothing to seed.
  if (messages.length <= 1) return null;

  // Resolve each human author once. Best-effort: a failed lookup falls back to
  // the raw id so one dead user never blanks the transcript.
  const userIds = [...new Set(messages.map((m) => str((m as RawReply).user)).filter((u): u is string => !!u))];
  const names = new Map<string, string>();
  await Promise.all(
    userIds.map(async (id) => {
      const info = await api.usersInfo(id).catch(() => null);
      if (info) names.set(id, info.displayName);
    }),
  );

  const lines: string[] = [];
  for (const raw of messages as RawReply[]) {
    const text = cleanSlackText(str(raw.text) ?? "", opts.selfUserId);
    if (!text) continue; // a join notice or a file-only post carries no words to seed.
    const userId = str(raw.user);
    const who = userId
      ? names.get(userId) ?? `@${userId}`
      : str(raw.username) ?? str((raw.bot_profile as Record<string, unknown> | undefined)?.name) ?? "app";
    lines.push(`${who}: ${text}`);
  }
  if (lines.length === 0) return null;

  // Keep the most recent messages when the thread runs long — the tail is the
  // part the trigger message replies to.
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  let omitted = 0;
  while (lines.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= lines[0].length + 1;
    lines.shift();
    omitted += 1;
  }
  const body = lines.join("\n");
  return omitted > 0 ? `[${omitted} earlier message(s) omitted]\n${body}` : body;
}
