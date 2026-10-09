/**
 * Reads a GitHub App `push` delivery, for `ContentSyncService.onPush`.
 *
 * Every enabled source in the org that tracks the pushed repository and ref
 * is marked due, whoever owns it. This used to be org sources only, on the
 * reasoning that a personal or team source often has no App installation:
 * true, and it does not matter. A source with no installation still polls,
 * and marking it due only moves its next poll forward.
 */
import type { GithubPushRef } from "@valet/plugin-github/http";

/** The GitHub plugin owns push payload parsing for its webhook. */
export { parseContentPushPayload } from "@valet/plugin-github/http";
export type ContentPushRef = GithubPushRef;

/** True when this source tracks the branch or tag the push moved. An empty
 * source ref means the repository default branch. */
export function contentSourceRefMatchesPush(sourceRef: string, push: ContentPushRef): boolean {
  const branch = push.gitRef.startsWith("refs/heads/") ? push.gitRef.slice("refs/heads/".length) : null;
  const tag = push.gitRef.startsWith("refs/tags/") ? push.gitRef.slice("refs/tags/".length) : null;
  const short = branch ?? tag;
  if (sourceRef === "") {
    return branch !== null && branch === push.defaultBranch;
  }
  return sourceRef === push.gitRef || (short !== null && sourceRef === short);
}
