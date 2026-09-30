import type { ThreadPullRequest, ThreadSummary } from "@valet/api/wire";

/** A thread is unread when the agent wrote after the viewer last read or acted in it. */
export function isThreadUnread(thread: Pick<ThreadSummary, "lastAgentActivityAt" | "readAt" | "lastUserActivityAt">): boolean {
  if (thread.lastAgentActivityAt === undefined) return false;
  return thread.lastAgentActivityAt > Math.max(thread.readAt ?? 0, thread.lastUserActivityAt);
}

/** The pull request a thread row shows: an open one first, then the newest. */
export function rowPullRequest(pullRequests: ThreadPullRequest[] | undefined): ThreadPullRequest | undefined {
  if (!pullRequests?.length) return undefined;
  return [...pullRequests].reverse().find((pr) => pr.state === "open") ?? pullRequests.at(-1);
}
