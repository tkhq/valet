/**
 * Reviews a person asks for by mentioning the GitHub App in a pull request
 * comment: `@<app> review` reviews the commits since the last review, and
 * `@<app> full review` reviews the whole pull request again. The comment can
 * be in the conversation or an inline review comment. The handler checks the
 * author's push access before it reviews.
 */
import type { PluginEvent } from "@valet/engine";

/** The comment events that can ask for a review. */
export const MENTION_EVENTS = ["github.issue_comment.created", "github.pull_request_review_comment.created"] as const;

/** `issue`: a comment in the pull request conversation. `review`: an inline review comment. */
export type CommentSurface = "issue" | "review";

/** A review a comment asks for. */
export interface ReviewRequest {
  /** The comment's database id. */
  commentId: number;
  surface: CommentSurface;
  /** The comment author's login. */
  author: string;
  /** `full review`: the whole pull request, not only the commits since the last review. */
  full: boolean;
}

/** Characters of a comment body searched for the command. */
const MAX_BODY = 20_000;

export function isMentionEvent(key: string): boolean {
  return (MENTION_EVENTS as readonly string[]).includes(key);
}

function record(value: unknown): Record<string, unknown> | undefined {
  // A webhook payload is parsed JSON: a non-array object has string keys.
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The handle people type for the App: its bot login without `[bot]`. */
export function mentionHandle(appLogin: string): string {
  return appLogin.replace(/\[bot\]$/i, "");
}

/**
 * The review a comment event asks for, or undefined. `appLogin` is the
 * App's bot login, `<app-slug>[bot]`. A comment on an issue that is not a
 * pull request, a comment by a bot, or the App's own comment asks for none.
 */
export function reviewRequest(event: Pick<PluginEvent, "key" | "payload">, appLogin: string): ReviewRequest | undefined {
  if (!isMentionEvent(event.key)) return undefined;
  const payload = record(event.payload);
  const comment = record(payload?.comment);
  if (!payload || !comment) return undefined;
  const surface: CommentSurface = event.key === "github.issue_comment.created" ? "issue" : "review";
  // A conversation comment arrives as an issue comment; only a pull request's issue has `pull_request`.
  if (surface === "issue" && record(record(payload.issue)?.pull_request) === undefined) return undefined;
  const user = record(comment.user);
  const author = typeof user?.login === "string" ? user.login : undefined;
  if (!author || user?.type === "Bot" || author.toLowerCase() === appLogin.toLowerCase()) return undefined;
  if (typeof comment.id !== "number" || typeof comment.body !== "string") return undefined;
  const command = mentionCommand(comment.body, appLogin);
  return command ? { commentId: comment.id, surface, author, full: command === "full" } : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `review` or `full` when a line of `body` mentions the App with that
 * command, as `@<app> review` or `@<app> full review` (any case). Quoted
 * lines and code do not count, so a reply that quotes a request asks for
 * nothing.
 */
export function mentionCommand(body: string, appLogin: string): "review" | "full" | undefined {
  const handle = mentionHandle(appLogin);
  if (!handle) return undefined;
  const pattern = new RegExp(`(?:^|[^\\w@/.-])@${escapeRegExp(handle)}(?:\\[bot\\])?(?![\\w-])[\\s,:]+(full\\s+)?review\\b`, "i");
  let fenced = false;
  for (const raw of body.slice(0, MAX_BODY).split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith(">")) continue;
    const match = pattern.exec(line.replace(/`[^`]*`/g, ""));
    if (match) return match[1] ? "full" : "review";
  }
  return undefined;
}
