/**
 * A thread's plan, as the `update_plan` tool stores it in thread metadata
 * (`THREAD_PLAN_KEY`). The engine writes it; the API reads it for the web
 * view and for progress lines on task rows.
 */
import { readThreadPlan, type SessionStore, type ThreadPlan } from "@valet/engine";

export { planProgress } from "@valet/shared";

/** The plan stored for the thread, or undefined when it has none. */
export async function readStoredThreadPlan(
  store: Pick<SessionStore, "getThread">, sessionId: string, threadId: string,
): Promise<ThreadPlan | undefined> {
  return readThreadPlan((await store.getThread(sessionId, threadId))?.metadata);
}
