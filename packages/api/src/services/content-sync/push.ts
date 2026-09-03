/**
 * Reads a GitHub App `push` delivery, for `ContentSyncService.onPush`.
 *
 * Every enabled source in the org that tracks the pushed repository and ref
 * is marked due, whoever owns it. This used to be org sources only, on the
 * reasoning that a personal or team source often has no App installation:
 * true, and it does not matter. A source with no installation still polls,
 * and marking it due only moves its next poll forward.
 */
export interface ContentPushRef {
  repoFullName: string;
  gitRef: string;
  defaultBranch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The repository and ref a `push` names, or null when the payload is not a push. */
export function parseContentPushPayload(payload: unknown): ContentPushRef | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.ref !== "string" || payload.ref.length === 0) return null;
  const repository = payload.repository;
  if (!isRecord(repository) || typeof repository.full_name !== "string") return null;
  const defaultBranch =
    typeof repository.default_branch === "string" && repository.default_branch.length > 0
      ? repository.default_branch
      : "main";
  return { repoFullName: repository.full_name, gitRef: payload.ref, defaultBranch };
}

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
