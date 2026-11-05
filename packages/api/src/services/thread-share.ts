/**
 * Thread sharing (docs/specs/2026-10-13-thread-sharing-design.md). The owner
 * of a personal thread can let other members of their organization open that
 * one thread by its link: to watch it ("view"), or to watch it and send
 * prompts ("reply"). The thread stays in the owner's workspace and runs as the
 * owner: the owner's connected accounts, permission settings, and approvals.
 *
 * A share admits a person to one thread, never to the session around it. The
 * thread-addressed routes (`routes/threads.ts`) and the session stream
 * (`routes/ws.ts`) are the only ways in, and both read the share on every
 * request, so turning a share off takes effect on the next request.
 */
import { and, eq } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import { sessionThreads } from "../schema/index.js";
import type { ThreadShareMode } from "../wire/types.js";
import { isOrgMember } from "./org.js";

export function isThreadShareMode(value: unknown): value is ThreadShareMode {
  return value === "view" || value === "reply";
}

/** What a share admits a guest to. "read" is the thread's history, live
 * stream, and pending approvals; "reply" adds prompts and stopping a turn. */
export type ThreadShareNeed = "read" | "reply";

export function shareAllows(mode: ThreadShareMode, need: ThreadShareNeed): boolean {
  return need === "read" || mode === "reply";
}

/**
 * The share mode that admits `caller` to one thread of a session they cannot
 * otherwise view, or null. Only a personal session's thread can be shared,
 * and only with a person who is a live member of the session's organization.
 * The owner never reads as a guest of their own thread.
 */
export async function threadShareGrant(
  db: AppQueryable,
  session: { id: string; orgId: string; ownerType: string; userId: string; status: string },
  threadId: string,
  caller: RequestPrincipal,
): Promise<ThreadShareMode | null> {
  if (caller.type !== "user" || session.ownerType !== "user" || session.status === "deleted") return null;
  if (session.userId === caller.id) return null;
  const [row] = await db.select({ shareMode: sessionThreads.shareMode }).from(sessionThreads)
    .where(and(eq(sessionThreads.id, threadId), eq(sessionThreads.sessionId, session.id))).limit(1);
  if (!isThreadShareMode(row?.shareMode)) return null;
  return await isOrgMember(db, session.orgId, caller.id) ? row.shareMode : null;
}

/** Counts share changes in this process. A live stream compares it to decide
 * whether its cached grant is stale, so a revoke reaches it at once. */
let shareWrites = 0;

export function shareWriteCount(): number {
  return shareWrites;
}

/** Sets or clears a thread's share. The caller has checked that the thread is
 * personal and that the caller owns it. */
export async function setThreadShare(
  db: AppQueryable,
  thread: { id: string; sessionId: string; createdAt: number },
  mode: ThreadShareMode | null,
): Promise<void> {
  await db.insert(sessionThreads)
    .values({ id: thread.id, sessionId: thread.sessionId, createdAt: thread.createdAt, shareMode: mode })
    .onConflictDoUpdate({ target: sessionThreads.id, set: { shareMode: mode } });
  shareWrites += 1;
}
