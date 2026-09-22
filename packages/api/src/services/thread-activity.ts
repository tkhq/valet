import { sql } from "drizzle-orm";
import type { EngineEvent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { sessionThreads } from "../schema/index.js";

type ThreadActivityEvent = Extract<EngineEvent, { type: "thread_user_activity" }>;

/** Log an activity failure without failing a prompt that the engine accepted. */
export async function recordThreadActivityBestEffort(record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch (err) {
    console.error("Thread activity recording failed after prompt acceptance:", err);
  }
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

  await input.emit({
    type: "thread_user_activity",
    threadId: input.threadId,
    activityAt: rows[0]?.lastUserActivityAt ?? input.activityAt,
  });
}
