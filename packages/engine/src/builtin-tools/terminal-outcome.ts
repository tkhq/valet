import type { ToolResult } from "../types.js";

/** A GitHub CLI call in command position: the start, or after `;`, `&&`,
 * `||`, `|`, `(`, or `$(`, so `echo gh pr create` is not one. */
const GH = String.raw`(?:^|[;&|(\n]|\$\()\s*(?:gh|valet-gh|\/usr\/local\/bin\/gh)\s+`;
const COMMENT_WRITE = new RegExp(`${GH}(?:pr\\s+comment\\b|api\\b[^\\n]*\\/comments\\b)`);
const PR_CREATE = new RegExp(`${GH}pr\\s+create\\b`);
const COMMENT_URL = /https:\/\/[^\s/"]+\/[^\s/"]+\/[^\s/"]+\/pull\/\d+#issuecomment-\d+/;
const PR_URL = /https:\/\/[^\s/"]+\/[^\s/"]+\/[^\s/"]+\/pull\/\d+\b/;

/**
 * Recognize GitHub CLI writes from a terminal command and its output.
 *
 * A comment is recorded by the URL `gh` prints, whatever the command around
 * it looks like (a body with `|` or `&`, a chained push), and whatever the
 * exit code: the record only keeps Valet from waking on its own comment.
 * A review prints nothing to confirm it, so only a direct, successful
 * `gh pr review` with a verdict flag counts.
 */
export function terminalOutcome(
  command: string,
  output: string,
  exitCode: number | undefined,
): ToolResult["outcome"] {
  if (COMMENT_WRITE.test(command)) {
    const url = output.match(COMMENT_URL)?.[0];
    if (url) return { kind: "pull_request_comment", url };
  }
  if (exitCode !== 0) return undefined;
  if (PR_CREATE.test(command)) {
    const url = output.match(PR_URL)?.[0];
    return url ? { kind: "pull_request_created", url } : undefined;
  }
  const review = command.match(/^\s*(?:cd\s+[^;&|\n]+\s*&&\s*)?((?:gh|valet-gh|\/usr\/local\/bin\/gh)\s+pr\s+review\b[^\n]*)$/);
  if (!review || /[;&|`]|\$\(/.test(review[1]!)) return undefined;
  return /(?:^|\s)--(?:approve|request-changes|comment)(?:\s|$)/.test(command)
    ? { kind: "review_submitted" }
    : undefined;
}
