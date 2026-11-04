/**
 * Display state for the thread an assistant delivery lands in (spec
 * 2026-10-16-delivery-threads-and-claims-design.md, Part B steps 3 and 4).
 * Archive state and the sidebar title live on the api's `session_threads`
 * mirror row, not in the engine, so both writes happen here.
 */
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";

/**
 * Reopen an archived thread that a delivery found by key. For a team
 * execution session, the governing thread in the assistant's root session
 * reopens too, because the delivery check reads both. Returns the number of
 * rows reopened. A thread with no mirror row is not archived, so an update
 * (not an upsert) is enough.
 */
export async function reopenThread(db: AppDb, sessionId: string, threadId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE session_threads SET archived_at = NULL
    WHERE archived_at IS NOT NULL AND (
      (session_id = ${sessionId} AND id = ${threadId})
      OR (session_id, id) IN (
        SELECT a.session_id, x.governing_thread_id FROM assistant_executions x
        JOIN assistants a ON a.id = x.assistant_id
        WHERE x.session_id = ${sessionId}))
    RETURNING id`) as { rows: Array<{ id: string }> };
  return result.rows.length;
}

/**
 * Give a delivery thread its policy title when the thread has none yet. A
 * title that a person or auto-title already wrote stays. For a team
 * execution session, the governing thread gets the same title, because the
 * team's thread list shows that thread.
 */
export async function seedThreadTitle(
  db: AppDb,
  thread: { sessionId: string; threadId: string; createdAt: number },
  title: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO session_threads (id, session_id, created_at, title)
    VALUES (${thread.threadId}, ${thread.sessionId}, ${thread.createdAt}, ${title})
    ON CONFLICT (id) DO UPDATE SET title = COALESCE(session_threads.title, EXCLUDED.title)`);
  await db.execute(sql`
    INSERT INTO session_threads (id, session_id, created_at, title)
    SELECT g.id, g.session_id, g.created_at, ${title} FROM assistant_executions x
    JOIN assistants a ON a.id = x.assistant_id
    JOIN engine_threads g ON g.session_id = a.session_id AND g.id = x.governing_thread_id
    WHERE x.session_id = ${thread.sessionId}
    ON CONFLICT (id) DO UPDATE SET title = COALESCE(session_threads.title, EXCLUDED.title)`);
}
