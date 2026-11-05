import type { ThreadPullRequest, ThreadSummary } from "@valet/api/wire";

/**
 * A thread is unread when the agent wrote after the viewer last read or acted
 * in it. A team thread notifies only the people who wrote in it.
 */
export function isThreadUnread(thread: Pick<ThreadSummary, "lastAgentActivityAt" | "readAt" | "lastUserActivityAt" | "participant">): boolean {
  if (thread.lastAgentActivityAt === undefined || thread.participant === false) return false;
  return thread.lastAgentActivityAt > Math.max(thread.readAt ?? 0, thread.lastUserActivityAt);
}

/** The question Valet asked in its newest message, while nobody has replied since. A team thread asks only the people who wrote in it. */
export function pendingAgentQuestion(thread: Pick<ThreadSummary, "agentQuestion" | "lastAgentActivityAt" | "lastUserActivityAt" | "participant">): string | undefined {
  if (!thread.agentQuestion || thread.lastAgentActivityAt === undefined || thread.participant === false) return undefined;
  return thread.lastAgentActivityAt > thread.lastUserActivityAt ? thread.agentQuestion : undefined;
}

/** The pull request a thread row shows: an open one first, then the newest. */
export function rowPullRequest(pullRequests: ThreadPullRequest[] | undefined): ThreadPullRequest | undefined {
  if (!pullRequests?.length) return undefined;
  return [...pullRequests].reverse().find((pr) => pr.state === "open") ?? pullRequests.at(-1);
}
