/**
 * The follow store for Slack thread auto-follow. A `followed_threads` row binds
 * one Slack thread to one owner's assistant: once bound (by a follow-enabled
 * mention), later messages in that thread route to the assistant without a
 * re-mention. One row per `(org, channel, thread)`.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { followedThreads } from "../schema/index.js";

export interface FollowedThreadKey {
  orgId: string;
  channelType: string;
  channelId: string;
  threadTs: string;
}

export interface FollowedThreadRow extends FollowedThreadKey {
  ownerType: "user" | "team" | "org";
  ownerId: string;
  createdBy: string;
}

/** Bind a thread to an owner's assistant. Idempotent on `(org, channel, thread)`. */
export async function upsertFollowedThread(db: AppDb, row: FollowedThreadRow): Promise<void> {
  const now = Date.now();
  await db
    .insert(followedThreads)
    .values({
      id: randomUUID(),
      orgId: row.orgId,
      channelType: row.channelType,
      channelId: row.channelId,
      threadTs: row.threadTs,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      createdBy: row.createdBy,
      createdAt: now,
      lastActivityAt: now,
    })
    .onConflictDoUpdate({
      target: [
        followedThreads.orgId,
        followedThreads.channelType,
        followedThreads.channelId,
        followedThreads.threadTs,
      ],
      set: { ownerType: row.ownerType, ownerId: row.ownerId, lastActivityAt: now },
    });
}

/** The follow record for a thread, or `null` when the thread is not followed. */
export async function findFollowedThread(db: AppDb, key: FollowedThreadKey) {
  const rows = await db
    .select()
    .from(followedThreads)
    .where(
      and(
        eq(followedThreads.orgId, key.orgId),
        eq(followedThreads.channelType, key.channelType),
        eq(followedThreads.channelId, key.channelId),
        eq(followedThreads.threadTs, key.threadTs),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Record that a followed thread just saw activity. */
export async function touchFollowedThread(db: AppDb, id: string): Promise<void> {
  await db.update(followedThreads).set({ lastActivityAt: Date.now() }).where(eq(followedThreads.id, id));
}
