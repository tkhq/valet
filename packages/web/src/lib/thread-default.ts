import type { ThreadSummary } from "@valet/api/wire";

/** The person's home conversation: the phone's first screen, the pinned Home
 * row of the web sidebar, and the destination of earlier linked Slack DMs. */
export function isHomeThread(thread: Pick<ThreadSummary, "key">): boolean {
  return thread.key === "home";
}

/** Helper conversations, workflow threads, and the home conversation: never
 * the thread a workspace opens by default, and private to their person. */
export function isAppAssistantThread(thread: Pick<ThreadSummary, "key">): boolean {
  return Boolean(thread.key?.startsWith("app-assistant:") || thread.key?.startsWith("workflow:") || isHomeThread(thread));
}

/** Threads that are not rows in the thread list: workflow threads, and the
 * home conversation, which the web sidebar pins above the list instead.
 * Earlier helper conversations from the side panel are rows, so they stay
 * reachable. */
export function isHiddenFromThreadList(thread: Pick<ThreadSummary, "key">): boolean {
  return Boolean(thread.key?.startsWith("workflow:") || isHomeThread(thread));
}

/** The implicit thread is always the newest created thread, regardless of sidebar sort. */
export function defaultThreadId(threads: ThreadSummary[]): string | undefined {
  return threads.filter((thread) => !isAppAssistantThread(thread)).reduce<ThreadSummary | undefined>(
    (newest, thread) => !newest || thread.createdAt > newest.createdAt || (thread.createdAt === newest.createdAt && thread.id.localeCompare(newest.id) < 0) ? thread : newest,
    undefined,
  )?.id;
}

/** Who can see a team thread, as the thread shows it: a helper or editor
 * thread is its person's alone, and a Slack thread follows its channel. */
export function teamThreadNotice(teamName: string, key: string | null | undefined): string {
  if (isAppAssistantThread({ key: key ?? undefined })) return "Only you can see this thread.";
  if (key?.startsWith("slack:") || key?.startsWith("slack-events:")) return `Shared with ${teamName} members who can see this Slack channel.`;
  return `Shared with ${teamName}. Members can read and reply.`;
}
