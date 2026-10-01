/**
 * Channel keys and the `channel_messages` record: what Valet sent to, or
 * received from, a Slack channel or a pull request, and the engine thread
 * each message belongs to.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { channelMessages } from "../schema/index.js";
import { resolveGithubUrl } from "./github-env.js";
import type { ThreadChannelActivity } from "../wire/types.js";

export type ChannelProvider = "slack" | "github";

export type ParsedChannelKey =
  | { provider: "slack"; channelId: string }
  | { provider: "github"; owner: string; repo: string; number: number };

const SLACK_CHANNEL = /^[A-Z0-9]+$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/** `slack:C123`. */
export function slackChannelKey(channelId: string): string {
  return `slack:${channelId}`;
}

/** `github:acme/app#12`. GitHub names are case-insensitive, so the key is lowercase. */
export function githubPullRequestKey(owner: string, repo: string, number: number): string {
  return `github:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

export function parseChannelKey(key: string): ParsedChannelKey | null {
  const slack = /^slack:([^:]+)$/.exec(key);
  if (slack && SLACK_CHANNEL.test(slack[1]!)) return { provider: "slack", channelId: slack[1]! };
  const github = /^github:([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  if (github && GITHUB_NAME.test(github[1]!) && GITHUB_NAME.test(github[2]!)) {
    return { provider: "github", owner: github[1]!, repo: github[2]!, number: Number(github[3]) };
  }
  return null;
}

/** The parts of a Slack engine thread key (`slack:C123:<thread ts>`), DMs included. */
function slackThreadParts(key: string | null | undefined): { channelId: string; threadTs: string } | null {
  const match = /^slack:([^:]+):([^:]+)$/.exec(key ?? "");
  if (!match || !SLACK_CHANNEL.test(match[1]!) || !/^\d+\.\d+$/.test(match[2]!)) return null;
  return { channelId: match[1]!, threadTs: match[2]! };
}

/**
 * The Slack conversation an engine thread key names. A DM (`D…`) is a
 * personal conversation, not a channel, so it reads as null.
 */
export function slackConversationFromThreadKey(key: string | null | undefined): { channelId: string; threadTs: string } | null {
  const parts = slackThreadParts(key);
  return parts && !parts.channelId.startsWith("D") ? parts : null;
}

/** Where a Slack engine thread key opens in Slack, DMs included. Slack routes a
 * signed-in reader to the right workspace, so the team id is not needed. */
export function slackThreadUrl(key: string | null | undefined): string | undefined {
  const parts = slackThreadParts(key);
  return parts ? slackMessageUrl(parts.channelId, parts.threadTs) : undefined;
}

/** A Slack message permalink. With `threadTs`, a reply opens inside its thread. */
export function slackMessageUrl(channelId: string, ts: string, threadTs?: string): string {
  const base = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

/** Where a channel opens in its provider. */
export function channelUrl(key: string, githubUrl = resolveGithubUrl(process.env)): string | undefined {
  const parsed = parseChannelKey(key);
  if (!parsed) return undefined;
  if (parsed.provider === "slack") return `https://slack.com/archives/${parsed.channelId}`;
  return `${githubUrl.replace(/\/+$/, "")}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
}

export interface ChannelMessageInput {
  orgId: string;
  sessionId: string;
  threadId: string;
  channelKey: string;
  conversationKey: string;
  providerMessageId: string;
  direction: "in" | "out";
  author?: string;
  text?: string;
  url?: string;
  createdAt?: number;
}

/** The part of a channel message a delivery knows before it lands on a thread. */
export type InboundChannelMessage = Omit<ChannelMessageInput, "orgId" | "sessionId" | "threadId" | "direction">;

const TEXT_CAP = 500;

/**
 * Records one channel message. A repeat of the same provider message is
 * ignored. A failure logs and returns: this record is a view aid, and the
 * delivery it describes has already happened.
 */
export async function recordChannelMessage(db: AppDb, input: ChannelMessageInput): Promise<void> {
  try {
    await db.insert(channelMessages).values({
      id: randomUUID(),
      orgId: input.orgId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      channelKey: input.channelKey,
      conversationKey: input.conversationKey,
      providerMessageId: input.providerMessageId,
      direction: input.direction,
      author: input.author ?? null,
      text: input.text ? input.text.slice(0, TEXT_CAP) : null,
      url: input.url ?? null,
      createdAt: input.createdAt ?? Date.now(),
    }).onConflictDoNothing();
  } catch (err) {
    console.error("[channels] could not record a channel message", err);
  }
}

/** The Slack message behind a delivered channel signal, for the inbound record. */
export function inboundSlackMessage(
  threadKey: string, messageTs: string | undefined, author: string | undefined, text: string,
): InboundChannelMessage | undefined {
  const conversation = slackConversationFromThreadKey(threadKey);
  if (!conversation || !messageTs) return undefined;
  return {
    channelKey: slackChannelKey(conversation.channelId),
    conversationKey: threadKey,
    providerMessageId: messageTs,
    ...(author ? { author } : {}),
    text,
    url: slackMessageUrl(conversation.channelId, messageTs, conversation.threadTs),
  };
}

/** The pull request events that belong to the pull request's own conversation. */
export const PULL_REQUEST_CONVERSATION_EVENTS: ReadonlySet<string> = new Set([
  "github.issue_comment.created",
  "github.pull_request_review.submitted",
  "github.pull_request_review_comment.created",
]);

interface GithubPayload {
  issue?: { pull_request?: { html_url?: string } };
  pull_request?: { html_url?: string };
  comment?: { id?: number; html_url?: string; body?: string; pull_request_review_id?: number; created_at?: string; user?: { login?: string; type?: string } };
  review?: { id?: number; html_url?: string; body?: string | null; state?: string; submitted_at?: string; user?: { login?: string; type?: string } };
}

/**
 * The pull request URL and the comment a GitHub event carries, or null for an
 * event that is not a person's comment or review on a pull request.
 */
export function pullRequestComment(eventKey: string, payload: unknown): {
  pullRequestUrl: string; message: InboundChannelMessage; channelKey: string;
  /** The review an inline comment belongs to, so a review Valet sent covers its comments. */
  reviewId?: string;
  /** When GitHub says the comment or review was posted, in ms. */
  postedAt?: number;
} | null {
  if (!PULL_REQUEST_CONVERSATION_EVENTS.has(eventKey) || !payload || typeof payload !== "object") return null;
  const body = payload as GithubPayload;
  const pullRequestUrl = body.pull_request?.html_url ?? body.issue?.pull_request?.html_url;
  const item = body.comment ?? body.review;
  if (!pullRequestUrl || !item?.id) return null;
  // A bot's comment, Valet's own GitHub App included, is not a person
  // continuing the conversation. It stays on the shared events thread, so the
  // agent never wakes on the comment it just posted.
  if (item.user?.type === "Bot" || item.user?.login?.endsWith("[bot]")) return null;
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullRequestUrl);
  if (!match) return null;
  const channelKey = githubPullRequestKey(match[1]!, match[2]!, Number(match[3]));
  const reviewState = body.review?.state ? `Review: ${body.review.state.toLowerCase().replace(/_/g, " ")}` : undefined;
  const text = item.body || reviewState || "";
  const reviewId = body.comment?.pull_request_review_id;
  const postedAt = Date.parse(body.comment?.created_at ?? body.review?.submitted_at ?? "");
  return {
    pullRequestUrl,
    channelKey,
    ...(reviewId !== undefined ? { reviewId: String(reviewId) } : {}),
    ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    message: {
      channelKey,
      conversationKey: channelKey,
      providerMessageId: String(item.id),
      ...(item.user?.login ? { author: item.user.login } : {}),
      text,
      ...(item.html_url ? { url: item.html_url } : {}),
    },
  };
}

interface ActionRecord {
  actionId: string;
  status: string;
  orgId?: string;
  sessionId: string;
  threadId: string;
  params?: unknown;
  result?: unknown;
}

const SLACK_SEND_ACTIONS = new Set(["slack.send_message", "slack.reply_to_origin"]);

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The outbound message a completed channel action posted, or null. `threadKey`
 * is the engine thread's key: `reply_to_origin` takes no thread argument, so
 * its Slack thread is the one the engine thread names.
 */
export function actionChannelMessage(record: ActionRecord, threadKey: string | null): ChannelMessageInput | null {
  if (record.status !== "completed" || !record.orgId || field(record.result, "success") !== true) return null;
  const data = field(record.result, "data");
  const base = { orgId: record.orgId, sessionId: record.sessionId, threadId: record.threadId, direction: "out" as const };
  if (SLACK_SEND_ACTIONS.has(record.actionId)) {
    const channel = text(field(data, "channel"));
    const ts = text(field(data, "ts"));
    if (!channel || !ts || channel.startsWith("D") || !SLACK_CHANNEL.test(channel)) return null;
    const origin = slackConversationFromThreadKey(threadKey);
    const threadTs = text(field(record.params, "thread_ts"))
      ?? (record.actionId === "slack.reply_to_origin" && origin?.channelId === channel ? origin.threadTs : undefined)
      ?? ts;
    return {
      ...base,
      channelKey: slackChannelKey(channel),
      conversationKey: `slack:${channel}:${threadTs}`,
      providerMessageId: ts,
      ...(text(field(record.params, "text")) ? { text: text(field(record.params, "text")) } : {}),
      url: slackMessageUrl(channel, ts, threadTs),
    };
  }
  if (record.actionId === "github.create_review") {
    // The review's id is the one its webhook and its inline comments carry.
    const reviewId = field(data, "review_id");
    const url = text(field(data, "url"));
    const owner = text(field(record.params, "owner"));
    const repo = text(field(record.params, "repo"));
    const number = field(record.params, "pullNumber");
    if (reviewId === undefined || !owner || !repo || typeof number !== "number") return null;
    const channelKey = githubPullRequestKey(owner, repo, number);
    return {
      ...base, channelKey, conversationKey: channelKey, providerMessageId: String(reviewId),
      ...(text(field(record.params, "body")) ? { text: text(field(record.params, "body")) } : {}),
      ...(url ? { url } : {}),
    };
  }
  if (record.actionId === "github.create_comment") {
    const url = text(field(data, "html_url"));
    const id = field(data, "id");
    const owner = text(field(record.params, "owner"));
    const repo = text(field(record.params, "repo"));
    const number = field(record.params, "issueNumber");
    // An issue comment is not a pull request conversation.
    if (!url || !/\/pull\/\d+#/.test(url) || !owner || !repo || typeof number !== "number" || id === undefined) return null;
    const channelKey = githubPullRequestKey(owner, repo, number);
    return {
      ...base,
      channelKey,
      conversationKey: channelKey,
      providerMessageId: String(id),
      ...(text(field(data, "body")) ? { text: text(field(data, "body")) } : {}),
      url,
    };
  }
  return null;
}

/**
 * How much one thread has talked in its channel: the message count and the
 * newest message. A fixed-size summary, so a long thread costs one row.
 */
export async function threadChannelActivity(db: AppDb, sessionId: string, threadId: string): Promise<ThreadChannelActivity> {
  const scope = and(eq(channelMessages.sessionId, sessionId), eq(channelMessages.threadId, threadId));
  const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(channelMessages).where(scope);
  const [latest] = await db.select().from(channelMessages).where(scope).orderBy(desc(channelMessages.createdAt)).limit(1);
  return {
    total: Number(counted?.total ?? 0),
    latest: latest ? {
      id: latest.id, sessionId: latest.sessionId, threadId: latest.threadId, channelKey: latest.channelKey,
      direction: latest.direction, author: latest.author, text: latest.text, url: latest.url, createdAt: latest.createdAt,
    } : null,
  };
}

/**
 * Whether Valet recorded this provider message as one it sent. `alsoIds` names
 * the review an inline comment belongs to: a review Valet sent covers them.
 */
export async function wasSentByValet(
  db: AppDb, orgId: string, message: Pick<InboundChannelMessage, "channelKey" | "providerMessageId">, alsoIds: string[] = [],
): Promise<boolean> {
  const [row] = await db.select({ id: channelMessages.id }).from(channelMessages).where(and(
    eq(channelMessages.orgId, orgId), eq(channelMessages.channelKey, message.channelKey),
    inArray(channelMessages.providerMessageId, [message.providerMessageId, ...alsoIds]), eq(channelMessages.direction, "out"),
  )).limit(1);
  return row !== undefined;
}

/**
 * How long after posting a pull request comment can still turn out to be
 * Valet's own. GitHub can deliver the webhook before Valet records the write,
 * so a comment younger than this waits before it wakes a thread.
 */
export const OWN_WRITE_SETTLE_MS = 10_000;

/**
 * Whether a pull request comment or review is one Valet posted: by its id, by
 * the review an inline comment belongs to, or, for a review event, by a
 * terminal review on the same pull request within the window.
 */
export async function isOwnPullRequestWrite(
  db: AppDb, orgId: string, eventKey: string, comment: NonNullable<ReturnType<typeof pullRequestComment>>,
): Promise<boolean> {
  return await wasSentByValet(db, orgId, comment.message, comment.reviewId ? [comment.reviewId] : [])
    || (eventKey.startsWith("github.pull_request_review") && await recentTerminalReview(db, orgId, comment.channelKey));
}

/** How long a review Valet posted from the terminal (no id to match) keeps
 * review events on its pull request off the thread that posted it. */
export const TERMINAL_REVIEW_WINDOW_MS = 2 * 60_000;

/**
 * Whether Valet posted a review on this pull request from the terminal within
 * the window. `gh pr review` prints no review id, so the record names the time.
 */
export async function recentTerminalReview(db: AppDb, orgId: string, channelKey: string, now = Date.now()): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 FROM channel_messages
    WHERE org_id = ${orgId} AND channel_key = ${channelKey} AND direction = 'out'
      AND provider_message_id LIKE 'terminal-review:%' AND created_at >= ${now - TERMINAL_REVIEW_WINDOW_MS}
    LIMIT 1`) as { rows: unknown[] };
  return result.rows.length > 0;
}

/**
 * Records what Valet posted to a pull request from the sandbox terminal: a
 * `gh pr comment` by its comment id, and a `gh pr review` (which prints no
 * id) as a timed mark on each pull request the thread opened.
 */
export async function recordTerminalPullRequestWrite(
  db: AppDb, input: { orgId: string; sessionId: string; threadId: string; kind: "pull_request_comment" | "review_submitted"; url?: string },
  now = Date.now(),
): Promise<void> {
  const base = { orgId: input.orgId, sessionId: input.sessionId, threadId: input.threadId, direction: "out" as const, createdAt: now };
  if (input.kind === "pull_request_comment") {
    const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)#issuecomment-(\d+)$/.exec(input.url ?? "");
    if (!match) return;
    const channelKey = githubPullRequestKey(match[1]!, match[2]!, Number(match[3]));
    await recordChannelMessage(db, { ...base, channelKey, conversationKey: channelKey, providerMessageId: match[4]!, url: input.url! });
    return;
  }
  const opened = await db.execute(sql`SELECT url FROM thread_pull_requests
    WHERE session_id = ${input.sessionId} AND thread_id = ${input.threadId}`) as { rows: Array<{ url: string }> };
  for (const { url } of opened.rows) {
    const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
    if (!match) continue;
    const channelKey = githubPullRequestKey(match[1]!, match[2]!, Number(match[3]));
    await recordChannelMessage(db, {
      ...base, channelKey, conversationKey: channelKey, providerMessageId: `terminal-review:${now}`, url,
      text: "Posted a review from the terminal.",
    });
  }
}

/**
 * The key of the thread in `owner`'s workspace runtime that opened the pull
 * request at `url`, or null. A pull request comment for that owner goes to this
 * thread, so the conversation continues where the pull request started. An
 * archived thread is skipped: work there would run where no list shows it, so
 * the comment goes to the shared events thread instead.
 */
export async function threadKeyForPullRequest(
  db: AppDb, orgId: string, owner: Principal, url: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT et.key FROM thread_pull_requests pr
    JOIN assistants a ON a.session_id = pr.session_id
    JOIN engine_threads et ON et.session_id = pr.session_id AND et.id = pr.thread_id
    LEFT JOIN session_threads st ON st.session_id = pr.session_id AND st.id = pr.thread_id
    WHERE pr.url = ${url} AND a.org_id = ${orgId} AND a.owner_type = ${owner.type} AND a.owner_id = ${owner.id}
      AND a.archived_at IS NULL AND st.archived_at IS NULL
    ORDER BY pr.created_at DESC LIMIT 1`) as { rows: Array<{ key: string | null }> };
  return result.rows[0]?.key ?? null;
}

const CHANNEL_ACTIONS = new Set([...SLACK_SEND_ACTIONS, "github.create_comment", "github.create_review"]);

/** Records the channel message a completed send action posted. */
export async function recordActionChannelMessage(db: AppDb, record: ActionRecord): Promise<void> {
  if (!CHANNEL_ACTIONS.has(record.actionId) || record.status !== "completed") return;
  try {
    const result = await db.execute(sql`SELECT key FROM engine_threads
      WHERE session_id = ${record.sessionId} AND id = ${record.threadId}`) as { rows: Array<{ key: string | null }> };
    const message = actionChannelMessage(record, result.rows[0]?.key ?? null);
    if (message) await recordChannelMessage(db, message);
  } catch (err) {
    console.error("[channels] could not record an action's channel message", err);
  }
}
