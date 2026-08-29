/**
 * Turn Slack message text into agent-readable prose: strip the bot's own
 * mention, resolve every other `<@U…>` mention to a display name (not a raw id),
 * and collapse channel links and URL markup. This is the richer sibling of
 * `cleanSlackText` — that one leaves `<@U123>` as `@U123`; this one resolves it
 * to `@Real Name`. Used for everything an agent reads: the trigger message and
 * each line of a hydrated thread transcript.
 */
import type { SlackApi } from "./api.js";

/** Matches `<@U123>` and the labeled `<@U123|handle>` form. */
const USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The subset of `SlackApi` the enricher needs — a fake in tests supplies just this. */
export type EnrichApi = Pick<SlackApi, "usersInfo">;

export async function enrichSlackText(api: EnrichApi, text: string, selfUserId?: string): Promise<string> {
  // Resolve every mentioned user once; a failed lookup falls back to `@id`.
  const ids = [...new Set([...text.matchAll(USER_MENTION_RE)].map((m) => m[1]))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      if (selfUserId && id === selfUserId) return; // the bot's own mention is stripped, never resolved
      const info = await api.usersInfo(id).catch(() => null);
      if (info) names.set(id, info.displayName);
    }),
  );

  let out = text.replace(USER_MENTION_RE, (_m, id: string) => {
    if (selfUserId && id === selfUserId) return ""; // "@bot do X" → "do X"
    return `@${names.get(id) ?? id}`;
  });
  // Collapse the remaining Slack markup, same rules as cleanSlackText.
  out = out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1"); // <#C1|general> → #general
  out = out.replace(/<#([A-Z0-9]+)>/g, "#$1"); // bare <#C1> → #C1 (was passing through raw)
  out = out.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2"); // <url|label> → label
  out = out.replace(/<(https?:\/\/[^>]+)>/g, "$1"); // <url> → url
  return out.trim();
}
