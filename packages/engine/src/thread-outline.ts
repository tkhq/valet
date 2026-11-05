import type { SessionEntry, SessionStore, ThreadData } from "./types.js";

/**
 * The thread row and its entries without payloads, for walks over links,
 * types and queue items. A store without `getThreadOutline` serves the full
 * snapshot.
 */
export function readThreadOutline(
  store: Pick<SessionStore, "getThreadOutline" | "getThreadSnapshot">,
  sessionId: string,
  threadId: string,
): Promise<{ thread: ThreadData; entries: SessionEntry[] } | null> {
  return store.getThreadOutline ? store.getThreadOutline(sessionId, threadId) : store.getThreadSnapshot(sessionId, threadId);
}
