import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, assistants, sessionThreads } from "../schema/index.js";

/**
 * Seed one assistant session of `owner` with one thread, the shape an
 * `existing` thread policy names. `archived` marks the thread archived in
 * `session_threads`. The assistant row is keyed by owner, so seed one thread
 * per owner.
 */
export async function seedAssistantThread(
  db: AppDb,
  args: { orgId: string; owner: Principal; sessionId: string; threadId: string; archived?: boolean },
): Promise<{ sessionId: string; threadId: string }> {
  const { orgId, owner, sessionId, threadId } = args;
  await db.insert(agentSessions).values({
    id: sessionId, orgId, userId: owner.type === "user" ? owner.id : "member-9",
    ownerType: owner.type, ownerId: owner.id, workspace: "/workspace", createdAt: 1, updatedAt: 1,
  });
  await db.insert(assistants).values({
    id: `asst-${sessionId}`, orgId, ownerType: owner.type, ownerId: owner.id, sessionId, createdAt: 1,
  });
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES (${threadId}, ${sessionId}, ${threadId}, 'idle', 'steer', 1, 1)`);
  if (args.archived) {
    await db.insert(sessionThreads).values({ id: threadId, sessionId, createdAt: 1, archivedAt: Date.now() });
  }
  return { sessionId, threadId };
}
