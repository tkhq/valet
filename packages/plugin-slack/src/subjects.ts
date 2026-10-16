/**
 * Slack event normalization: subjects and bot detection (spec:
 * docs/specs/2026-10-15-event-wakeups-design.md, Part A1/A3/A5).
 */
import type { EventSubjects } from "@valet/engine";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface SlackEventSubjectsResult {
  subjects: string[];
  bot: boolean;
}

/** Event types that carry their own `ts` / `thread_ts` as a message timestamp. */
const MESSAGE_LIKE = new Set(["message", "app_mention", "bot_message"]);

/**
 * @param teamId The envelope team (`context.teamId`, from `team_id`). It
 * wins over the inner event's `team`: in a Slack Connect channel, `team`
 * names the sender's workspace, not the one Valet is installed in (spec
 * A3). The inner `team` is the fallback when the envelope has none.
 */
export function slackEventSubjects(
  eventType: string,
  payload: Record<string, unknown>,
  teamId: string | undefined,
): SlackEventSubjectsResult {
  const channelRec = rec(payload.channel);
  const itemRec = rec(payload.item);
  const channel = str(payload.channel) ?? str(channelRec?.id) ?? str(payload.channel_id) ?? str(itemRec?.channel);

  const userRec = rec(payload.user);
  const team = teamId ?? str(payload.team) ?? str(userRec?.team_id);

  const subjects: string[] = [];
  if (team) subjects.push(`slack:${team}`);
  if (team && channel) subjects.push(`slack:${team}/${channel}`);

  if (MESSAGE_LIKE.has(eventType)) {
    const threadTs = str(payload.thread_ts) ?? str(payload.ts);
    if (team && channel && threadTs) subjects.push(`slack:${team}/${channel}/${threadTs}`);
  }

  const botId = str(payload.bot_id) ?? str(rec(payload.bot_profile)?.id);
  const bot = !!botId || str(payload.subtype) === "bot_message";

  return { subjects, bot };
}

const PERMALINK_PATH_RE = /^\/archives\/([^/]+)(?:\/p(\d+))?\/?$/;

function tsFromPermalinkDigits(digits: string): string {
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

function fromUrl(url: string): { subject: string; slackChannel?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith(".slack.com")) return null;
  const m = PERMALINK_PATH_RE.exec(parsed.pathname);
  if (!m) return null;
  const channel = m[1];
  const threadTsParam = parsed.searchParams.get("thread_ts");
  if (threadTsParam) {
    return { subject: `slack:?/${channel}/${threadTsParam}`, slackChannel: channel };
  }
  const digits = m[2];
  if (digits) {
    return { subject: `slack:?/${channel}/${tsFromPermalinkDigits(digits)}`, slackChannel: channel };
  }
  return { subject: `slack:?/${channel}`, slackChannel: channel };
}

function label(subject: string): string {
  if (!subject.startsWith("slack:")) return subject;
  const rest = subject.slice("slack:".length);
  const parts = rest.split("/");
  if (parts.length >= 3) return `#${parts[1]} thread`;
  if (parts.length === 2) return `#${parts[1]}`;
  return `workspace ${parts[0]}`;
}

/** Slack has no deep link reconstructable from a subject alone — a
 * permalink needs the workspace domain, which the subject does not carry. */
function url(_subject: string): string | null {
  return null;
}

export const slackSubjects: EventSubjects = { fromUrl, label, url };
