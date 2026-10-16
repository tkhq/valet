import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, assistants, sessionThreads } from "../schema/index.js";

/** The session creator recorded for a team- or org-owned seed session. */
export const SEED_SESSION_CREATOR = "seed-member";

/**
 * Seed one session of `owner` with one thread, the shape an `existing`
 * thread policy names. By default the session is the owner's assistant
 * session; `assistant: false` seeds a plain session with no assistant row.
 * `archived` marks the thread archived in `session_threads`. The assistant
 * row is keyed by owner, so seed one assistant thread per owner.
 */
export async function seedAssistantThread(
  db: AppDb,
  args: {
    orgId: string;
    owner: Principal;
    sessionId: string;
    threadId: string;
    archived?: boolean;
    assistant?: boolean;
    creatorUserId?: string;
  },
): Promise<{ sessionId: string; threadId: string }> {
  const { orgId, owner, sessionId, threadId } = args;
  const creator = args.creatorUserId ?? (owner.type === "user" ? owner.id : SEED_SESSION_CREATOR);
  await db.insert(agentSessions).values({
    id: sessionId, orgId, userId: creator,
    ownerType: owner.type, ownerId: owner.id, workspace: "/workspace", createdAt: 1, updatedAt: 1,
  });
  if (args.assistant !== false) {
    await db.insert(assistants).values({
      id: `asst-${sessionId}`, orgId, ownerType: owner.type, ownerId: owner.id, sessionId, createdAt: 1,
    });
  }
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
    VALUES (${threadId}, ${sessionId}, ${threadId}, 'idle', 'steer', 1, 1)`);
  if (args.archived) {
    await db.insert(sessionThreads).values({ id: threadId, sessionId, createdAt: 1, archivedAt: Date.now() });
  }
  return { sessionId, threadId };
}
