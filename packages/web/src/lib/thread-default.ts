import type { ThreadSummary } from "@valet/api/wire";

/** The implicit thread is always the newest created thread, regardless of sidebar sort. */
export function defaultThreadId(threads: ThreadSummary[]): string | undefined {
  return threads.reduce<ThreadSummary | undefined>(
    (newest, thread) => !newest || thread.createdAt > newest.createdAt ? thread : newest,
    undefined,
  )?.id;
}
