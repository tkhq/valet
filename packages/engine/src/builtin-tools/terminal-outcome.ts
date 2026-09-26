import type { ToolResult } from "../types.js";

/** Recognize direct GitHub CLI writes. Compound scripts are left uncounted. */
export function terminalOutcome(
  command: string,
  output: string,
  exitCode: number | undefined,
): ToolResult["outcome"] {
  if (exitCode !== 0) return undefined;
  const direct = command.match(/^\s*(?:cd\s+[^;&|\n]+\s*&&\s*)?((?:gh|valet-gh|\/usr\/local\/bin\/gh)\s+pr\s+(create|review)\b[^\n]*)$/);
  if (!direct) return undefined;
  if (/[;&|`]|\$\(/.test(direct[1])) return undefined;
  if (direct[2] === "create") {
    const url = output.match(/https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\b/)?.[0];
    return url ? { kind: "pull_request_created", url } : undefined;
  }
  return /(?:^|\s)--(?:approve|request-changes|comment)(?:\s|$)/.test(command)
    ? { kind: "review_submitted" }
    : undefined;
}
