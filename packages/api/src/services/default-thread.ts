import type { Session } from "@valet/engine";

/**
 * Open the session's `web:default` thread where one belongs. A conversation
 * execution already has its own thread, and a read-only team root never
 * synthesizes a chat, so neither gets one: an execution opened in the web
 * listed the extra empty thread as a duplicate conversation.
 */
export async function ensureDefaultThreadWhereOwned(sessionId: string, engineSession: Session): Promise<void> {
  if (sessionId.startsWith("execution:") || engineSession.options.readOnlyReason) return;
  await engineSession.ensureDefaultThread();
}
