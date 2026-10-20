/** Thread access for a request's viewer (`services/thread-access.ts`). */
import type { Context } from "hono";
import type { WorkflowRunOrigin } from "@valet/workflow";
import type { AppEnv } from "../env.js";
import { canViewSession, type SessionOwnerLike } from "../services/session-access.js";
import { channelVisibility, requestViewer, runEventVisible, runOriginVisible as runOriginVisibleTo, storedThreadRef, threadVisibility, visibleThreadIds, type ThreadViewer, type ThreadVisibility } from "../services/thread-access.js";
import { threadShareGrant } from "../services/thread-share.js";
import type { ChannelVisibility } from "../services/channels.js";
import type { EventDeliveryThreadRef, ThreadShareMode } from "../wire/types.js";

export function viewerOf(c: Context<AppEnv>): ThreadViewer {
  return requestViewer(c.var.user.orgId, c.var.principal, c.var.user.id);
}

/** Which threads of `session` this request may see. */
export function threadsVisibleTo(c: Context<AppEnv>, session: { ownerType: string }): ThreadVisibility {
  return threadVisibility(c.var.providers, session, viewerOf(c));
}

/** Which channels this request may see. */
export function channelsVisibleTo(c: Context<AppEnv>): ChannelVisibility {
  return channelVisibility(c.var.providers, viewerOf(c));
}

/** The items of a workspace feed whose thread this request may see. An item
 * with no thread stays. */
export async function keepVisibleThreads<T extends { sessionId?: string; threadId?: string }>(
  c: Context<AppEnv>, owner: { type: string }, items: T[],
): Promise<T[]> {
  if (owner.type !== "team") return items;
  const threads = items.flatMap((item) => item.sessionId && item.threadId ? [{ sessionId: item.sessionId, threadId: item.threadId }] : []);
  const shown = await visibleThreadIds(c.var.providers, { ownerType: owner.type }, viewerOf(c), threads);
  // An item from a session with no thread cannot be judged, so it stays out.
  return items.filter((item) => !item.sessionId || (item.threadId !== undefined && shown.has(`${item.sessionId}:${item.threadId}`)));
}

/** Whether this request may see a session it can already view by owner: a
 * child session started from a private thread is visible only to the people
 * that thread belongs to (`governingThreadKeySql`). */
export async function spawnedFromVisibleThread(c: Context<AppEnv>, session: { ownerType: string; id: string }): Promise<boolean> {
  return session.ownerType !== "team" || threadsVisibleTo(c, session)(null);
}

/** How a request enters one thread of an assistant session: as a viewer of
 * the session, or as a guest that the thread's share admits. */
export type ThreadEntry = { as: "viewer" } | { as: "guest"; mode: ThreadShareMode };

/**
 * How this request may enter one thread of an assistant session at
 * `/threads/:threadId` (`routes/threads.ts`), or null. A viewer of the session
 * must also see the thread that started a child session. A person who may
 * not view the session enters only by the thread's share
 * (`services/thread-share.ts`). The thread routes and the event page's
 * thread links (`routes/events.ts`) use this rule, then check the thread's own
 * key with `threadsVisibleTo`.
 */
export async function threadEntry(
  c: Context<AppEnv>,
  session: SessionOwnerLike & { id: string; orgId: string; status: string },
  threadId: string,
): Promise<ThreadEntry | null> {
  const { db } = c.var.providers;
  if (await canViewSession(db, session, c.var.principal)) {
    return await spawnedFromVisibleThread(c, session) ? { as: "viewer" } : null;
  }
  const mode = await threadShareGrant(db, session, threadId, c.var.principal);
  return mode ? { as: "guest", mode } : null;
}

/** Whether this request may see a team workflow run: the thread it started
 * from (`runOriginVisible`) and the Slack channel whose event started it
 * (`runEventVisible`), each in `services/thread-access.ts`. */
export async function runVisible(
  c: Context<AppEnv>,
  run: { ownerType: string; origin?: WorkflowRunOrigin | null; actorUserId?: string | null; params?: { input?: unknown } },
): Promise<boolean> {
  const viewer = viewerOf(c);
  return await runOriginVisibleTo(c.var.providers, viewer, run)
    && (run.ownerType !== "team" || !run.params || await runEventVisible(c.var.providers, viewer, run.params));
}

/** A thread row with the session columns the thread access checks read,
 * and the thread's title and archived state. Raw SQL rows are untyped; each
 * caller's SELECT names these columns. */
export interface ThreadAccessRow {
  session_id: string; thread_id: string; key: string;
  org_id: string; status: string; user_id: string; owner_type: string; owner_id: string;
  title: string | null; archived: boolean | null;
}

/**
 * A checker that returns a thread's reference when this request may open it
 * at `/threads/:threadId` (`routes/threads.ts`), by the same two checks:
 * `threadEntry` (a viewer of the session, or a member the thread's share
 * admits), then `threadsVisibleTo` on the thread's key. It remembers each
 * thread's answer for the life of the checker. The event page's thread
 * links (`routes/events.ts`) and the routine thread (`routes/workflow-triggers.ts`)
 * share it.
 */
export type ThreadChecker = (row: ThreadAccessRow) => Promise<EventDeliveryThreadRef | null>;

export function readableThreads(c: Context<AppEnv>): ThreadChecker {
  const seen = new Map<string, Promise<EventDeliveryThreadRef | null>>();
  return (row) => {
    const key = `${row.session_id}:${row.thread_id}`;
    let answer = seen.get(key);
    if (!answer) {
      answer = (async () => {
        const session = { id: row.session_id, orgId: row.org_id, status: row.status, userId: row.user_id, ownerType: row.owner_type, ownerId: row.owner_id };
        if (!await threadEntry(c, session, row.thread_id)) return null;
        if (!await threadsVisibleTo(c, session)(await storedThreadRef(c.var.providers.db, row.session_id, row.thread_id, row.key))) return null;
        return {
          sessionId: row.session_id, threadId: row.thread_id,
          ...(row.title ? { title: row.title } : {}),
          ...(row.archived === true ? { archived: true as const } : {}),
        };
      })();
      seen.set(key, answer);
    }
    return answer;
  };
}
