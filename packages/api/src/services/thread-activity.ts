import { eq, sql } from "drizzle-orm";
import type { EngineEvent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, sessionThreads } from "../schema/index.js";

type ThreadActivityEvent = Extract<EngineEvent, { type: "thread_user_activity" }>;

/** Log an activity failure without failing a prompt that the engine accepted. */
export async function recordThreadActivityBestEffort(record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch (err) {
    console.error("Thread activity recording failed after prompt acceptance:", err);
  }
}

/** Persist a session touch without allowing a delayed submission to regress recency. */
export async function recordSessionActivity(db: AppDb, sessionId: string, activityAt: number): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      updatedAt: sql`GREATEST(${agentSessions.updatedAt}, ${activityAt})`,
      lastActivityAt: sql`GREATEST(COALESCE(${agentSessions.lastActivityAt}, ${activityAt}), ${activityAt})`,
    })
    .where(eq(agentSessions.id, sessionId));
}

/** Persist and publish one server-derived user activity timestamp. */
export async function recordThreadUserActivity(
  db: AppDb,
  input: {
    sessionId: string;
    threadId: string;
    threadCreatedAt: number;
    activityAt: number;
    emit: (event: ThreadActivityEvent) => Promise<void>;
  },
): Promise<void> {
  const rows = await db
    .insert(sessionThreads)
    .values({
      id: input.threadId,
      sessionId: input.sessionId,
      createdAt: input.threadCreatedAt,
      lastUserActivityAt: input.activityAt,
    })
    .onConflictDoUpdate({
      target: sessionThreads.id,
      set: {
        lastUserActivityAt: sql`GREATEST(COALESCE(${sessionThreads.lastUserActivityAt}, EXCLUDED.last_user_activity_at), EXCLUDED.last_user_activity_at)`,
      },
    })
    .returning({ lastUserActivityAt: sessionThreads.lastUserActivityAt });

  // This uses the same process-local live fan-out as every engine event.
  // Reconnect replay reads this durable event from Postgres on another API pod.
  await input.emit({
    type: "thread_user_activity",
    threadId: input.threadId,
    activityAt: rows[0]?.lastUserActivityAt ?? input.activityAt,
  });
}
