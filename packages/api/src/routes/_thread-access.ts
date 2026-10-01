/** Thread access for a request's viewer (`services/thread-access.ts`). */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { channelVisibility, requestViewer, threadVisibility, visibleThreadIds, type ThreadViewer, type ThreadVisibility } from "../services/thread-access.js";
import type { ChannelVisibility } from "../services/channels.js";

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
  return items.filter((item) => !item.sessionId || !item.threadId || shown.has(`${item.sessionId}:${item.threadId}`));
}
