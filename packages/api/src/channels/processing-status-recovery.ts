import { sql } from "drizzle-orm";
import type { ChannelTransport, QueueItem, SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ChannelProcessingStatus } from "./processing-status.js";

/** Restore only this organization's Slack submissions, in bounded keyset pages. */
export async function restoreProcessingStatus(
  db: AppDb, store: SessionStore, status: ChannelProcessingStatus, orgId: string, transport?: ChannelTransport,
): Promise<void> {
  let cursor = "";
  while (true) {
    const result = await db.execute(sql`
      SELECT q.id, q.session_id FROM engine_queue_items q
      JOIN engine_sessions s ON s.id = q.session_id
      WHERE s.org_id = ${orgId} AND q.status <> 'settled'
        AND (q.channel::jsonb ->> 'channelType' = 'slack' OR q.content::jsonb -> 'origin' ->> 'channelType' = 'slack') AND q.id > ${cursor}
      ORDER BY q.id LIMIT 100`) as { rows: Array<{ id: string; session_id: string }> }; // SQL projection has these two text columns.
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      const item = await store.getQueueItem(row.session_id, row.id);
      if (item) await trackProcessingItem(store, status, row.session_id, item, transport);

    }
    cursor = result.rows[result.rows.length - 1].id;
  }
}


/** Shared by live queue events and startup recovery. */
export async function trackProcessingItem(
  store: SessionStore, status: ChannelProcessingStatus, sessionId: string, item: QueueItem, transport?: ChannelTransport,
): Promise<void> {
  if (item.status === "settled") return;
  const origin = typeof item.content === "object" && "kind" in item.content && item.content.kind === "signal" ? item.content.origin : undefined;
  const conversationKey = item.channel?.channelType === "slack" ? item.channel.channelId
    : origin?.channelType === "slack" ? transport?.conversationKeyFromThreadKey?.(origin.threadKey) : undefined;
  if (!conversationKey) return;
  const match = /^slack:[^:]+:[^:]+:([0-9]+\.[0-9]+)$/.exec(conversationKey);
  if (!match) return;
  // Buffer live settlement and gate events while durable state is read.
  const turn = status.begin({ channelType: "slack", conversationKey, threadTs: match[1], sessionId, threadId: item.threadId }, item.id);
  if (!turn) return;
  try {
    const gates = await store.listDecisionGatesForQueueItem(sessionId, item.threadId, item.id);
    const latest = await store.getQueueItem(sessionId, item.id);
    if (!latest || latest.status === "settled") status.cancel(turn);
    else status.bind(turn, item.id, gates.find(gate => gate.status === "pending"));
  } catch (error) {
    status.cancel(turn);
    throw error;
  }
}
