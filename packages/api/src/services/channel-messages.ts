/**
 * Channel keys and the `channel_messages` record: what Valet sent to, or
 * received from, a Slack channel or a pull request, and the engine thread
 * each message belongs to. See docs/specs/2026-09-30-channels-design.md.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { channelMessages } from "../schema/index.js";
import { resolveGithubUrl } from "./github-env.js";

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

/** `github:acme/app#12`. */
export function githubPullRequestKey(owner: string, repo: string, number: number): string {
  return `github:${owner}/${repo}#${number}`;
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

/**
 * The Slack conversation an engine thread key names (`slack:C123:<thread ts>`).
 * A DM (`D…`) is a personal conversation, not a channel, so it reads as null.
 */
export function slackConversationFromThreadKey(key: string | null | undefined): { channelId: string; threadTs: string } | null {
  const match = /^slack:([^:]+):([^:]+)$/.exec(key ?? "");
  if (!match || !SLACK_CHANNEL.test(match[1]!) || match[1]!.startsWith("D")) return null;
  return { channelId: match[1]!, threadTs: match[2]! };
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
  comment?: { id?: number; html_url?: string; body?: string; user?: { login?: string; type?: string } };
  review?: { id?: number; html_url?: string; body?: string | null; state?: string; user?: { login?: string; type?: string } };
}

/**
 * The pull request URL and the comment a GitHub event carries, or null for an
 * event that is not a person's comment or review on a pull request.
 */
export function pullRequestComment(eventKey: string, payload: unknown): {
  pullRequestUrl: string; message: InboundChannelMessage; channelKey: string;
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
  return {
    pullRequestUrl,
    channelKey,
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

export interface ChannelMessageRow {
  id: string;
  sessionId: string;
  threadId: string;
  channelKey: string;
  conversationKey: string;
  direction: "in" | "out";
  author: string | null;
  text: string | null;
  url: string | null;
  createdAt: number;
}

/** One thread's channel messages, newest first. */
export async function listThreadChannelMessages(
  db: AppDb, sessionId: string, threadId: string, limit = 20,
): Promise<ChannelMessageRow[]> {
  return await db.select({
    id: channelMessages.id, sessionId: channelMessages.sessionId, threadId: channelMessages.threadId,
    channelKey: channelMessages.channelKey, conversationKey: channelMessages.conversationKey,
    direction: channelMessages.direction, author: channelMessages.author, text: channelMessages.text,
    url: channelMessages.url, createdAt: channelMessages.createdAt,
  }).from(channelMessages)
    .where(and(eq(channelMessages.sessionId, sessionId), eq(channelMessages.threadId, threadId)))
    .orderBy(desc(channelMessages.createdAt))
    .limit(limit);
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

const CHANNEL_ACTIONS = new Set([...SLACK_SEND_ACTIONS, "github.create_comment"]);

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
