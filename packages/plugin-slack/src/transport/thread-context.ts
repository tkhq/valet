/**
 * Format a Slack thread's prior messages as a plain attributed transcript, to
 * hydrate an assistant's first turn in that thread. One line per message,
 * `Name: text`, oldest first. The assistant reads this instead of fetching the
 * thread itself with `read_thread`, so it starts a group conversation with full
 * context rather than the lone trigger message.
 */
import type { SlackApi } from "./api.js";
import { enrichSlackText } from "./text-enrich.js";

/** Above this the middle lines are dropped — a long thread would swamp the turn. */
const MAX_TRANSCRIPT_CHARS = 6000;

interface RawReply {
  user?: unknown;
  username?: unknown;
  bot_profile?: unknown;
  text?: unknown;
  files?: unknown;
  ts?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A short marker for a message that carries files but no words, so a
 *  screenshot that IS the point does not vanish from the transcript. */
function fileMarker(raw: RawReply): string | null {
  const files = Array.isArray(raw.files) ? (raw.files as Record<string, unknown>[]) : [];
  if (files.length === 0) return null;
  const named = files.map((f) => str(f.name)).filter((n): n is string => !!n);
  return named.length ? `[shared: ${named.join(", ")}]` : `[shared ${files.length} file(s)]`;
}

/** Keep the thread's opening message (the topic) and the most recent tail; drop
 *  from the middle when the whole transcript is over budget. */
function trimToBudget(lines: string[]): string {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= MAX_TRANSCRIPT_CHARS || lines.length <= 2) return lines.join("\n");
  const root = lines[0];
  const rest = lines.slice(1);
  let running = root.length + 1 + rest.reduce((n, l) => n + l.length + 1, 0);
  let omitted = 0;
  while (rest.length > 1 && running > MAX_TRANSCRIPT_CHARS) {
    running -= rest[0].length + 1;
    rest.shift();
    omitted += 1;
  }
  return omitted > 0 ? [root, `[${omitted} earlier message(s) omitted]`, ...rest].join("\n") : [root, ...rest].join("\n");
}

/**
 * The subset of `SlackApi` this formatter needs, so a test can supply a fake
 * without building the whole client.
 */
export type ThreadContextApi = Pick<SlackApi, "conversationsReplies" | "usersInfo">;

export async function fetchThreadTranscript(
  api: ThreadContextApi,
  opts: {
    channelId: string;
    threadTs: string;
    selfUserId?: string;
    limit?: number;
    /** With `beforeTs`: keep only messages STRICTLY BETWEEN the two ts values
     * (the follow-router's gap window), and drop the bot's own posts — the
     * agent already holds its own replies as tool calls. */
    afterTs?: string;
    beforeTs?: string;
  },
): Promise<string | null> {
  const windowed = opts.afterTs !== undefined && opts.beforeTs !== undefined;
  let messages: Record<string, unknown>[];
  try {
    // A windowed fetch passes `oldest`: `conversations.replies` pages oldest
    // first, so without the bound a long thread's recent gap would fall
    // outside the first page entirely.
    messages = await api.conversationsReplies(opts.channelId, opts.threadTs, opts.limit ?? 100, opts.afterTs);
  } catch {
    return null; // thread gone, or the bot cannot read the channel — hydrate nothing.
  }
  if (windowed) {
    // Numeric compare, not lexicographic: a Slack ts is `seconds.micros` and
    // the seconds part could change digit count.
    const after = Number.parseFloat(opts.afterTs ?? "");
    const before = Number.parseFloat(opts.beforeTs ?? "");
    messages = messages.filter((m) => {
      const raw = m as RawReply;
      const ts = Number.parseFloat(str(raw.ts) ?? "");
      if (!Number.isFinite(ts) || ts <= after || ts >= before) return false;
      return !(opts.selfUserId !== undefined && str(raw.user) === opts.selfUserId);
    });
    if (messages.length === 0) return null;
  }
  // `conversations.replies` includes the trigger message itself. One message
  // means a fresh top-level mention with no prior replies — nothing to seed.
  if (!windowed && messages.length <= 1) return null;

  // Resolve each human author once. Best-effort: a failed lookup falls back to
  // the raw id so one dead user never blanks the transcript. Shares the client
  // name cache with the in-text mention resolution below.
  const authorIds = [...new Set(messages.map((m) => str((m as RawReply).user)).filter((u): u is string => !!u))];
  const authors = new Map<string, string>();
  await Promise.all(
    authorIds.map(async (id) => {
      const info = await api.usersInfo(id).catch(() => null);
      if (info) authors.set(id, info.displayName);
    }),
  );

  const formatted = await Promise.all(
    (messages as RawReply[]).map(async (raw) => {
      const body = await enrichSlackText(api, str(raw.text) ?? "", opts.selfUserId);
      const content = body || fileMarker(raw); // a file-only post keeps a marker, not nothing.
      if (!content) return null; // a join notice carries neither words nor files.
      const userId = str(raw.user);
      const who = userId
        ? userId === opts.selfUserId
          ? "You" // the assistant's own earlier reply — so it does not answer itself.
          : authors.get(userId) ?? `@${userId}`
        : str(raw.username) ?? str((raw.bot_profile as Record<string, unknown> | undefined)?.name) ?? "app";
      return `${who}: ${content}`;
    }),
  );
  const lines = formatted.filter((l): l is string => !!l);
  if (lines.length === 0) return null;

  return trimToBudget(lines);
}
