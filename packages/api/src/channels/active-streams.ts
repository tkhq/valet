/**
 * Durable record of open provider streams, and the two sweeps that close
 * them when the normal path cannot.
 *
 * Why this exists at all: the engine's `text_delta` plane is ephemeral
 * (`EventStream.publishEphemeral` — no append, no offset, no replay), while
 * a Slack stream is a long-lived provider-side object with no documented
 * timeout. The two facts together make the crash case ugly. If the api dies
 * between `chat.startStream` and `chat.stopStream`, nothing in the event log
 * says a stream was ever open, and the reader keeps a message that shimmers
 * until they give up on it. So the fact is written here instead.
 *
 * The deltas themselves are NOT recoverable and this module does not pretend
 * otherwise. `message_end` is durable and the web session shows the full
 * answer; a swept stream closes with a line that says so.
 */
import { and, eq, lt } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { channelActiveStreams } from "../schema/index.js";

export interface ActiveStreamRecord {
  channelType: string;
  conversationKey: string;
  /** Provider handle for the streaming message (Slack: chat.startStream's `ts`). */
  messageId: string;
  threadTs: string;
  sessionId: string;
  threadId: string;
  engineMessageId?: string;
  orgId: string;
  startedAt: number;
}

/** Storage seam. The bridge's tests use an in-memory implementation; the api
 * uses the Postgres one below. */
export interface ActiveStreamStore {
  insert(record: ActiveStreamRecord): Promise<void>;
  delete(key: { channelType: string; conversationKey: string; messageId: string }): Promise<void>;
  /** Every open stream for one transport, oldest first. */
  listForChannel(channelType: string): Promise<ActiveStreamRecord[]>;
  /** Open streams for one transport that started before `startedBefore`. */
  listStale(channelType: string, startedBefore: number): Promise<ActiveStreamRecord[]>;
}

export class DbActiveStreamStore implements ActiveStreamStore {
  constructor(private readonly db: AppDb) {}

  async insert(record: ActiveStreamRecord): Promise<void> {
    await this.db
      .insert(channelActiveStreams)
      .values({
        channelType: record.channelType,
        conversationKey: record.conversationKey,
        messageId: record.messageId,
        threadTs: record.threadTs,
        sessionId: record.sessionId,
        threadId: record.threadId,
        engineMessageId: record.engineMessageId ?? null,
        orgId: record.orgId,
        startedAt: record.startedAt,
      })
      // A provider message id is unique per conversation, so a conflict means
      // a retry of the same insert, not a second stream. Overwriting keeps the
      // freshest engine ids rather than failing the turn on a duplicate.
      .onConflictDoUpdate({
        target: [
          channelActiveStreams.channelType,
          channelActiveStreams.conversationKey,
          channelActiveStreams.messageId,
        ],
        set: {
          threadTs: record.threadTs,
          sessionId: record.sessionId,
          threadId: record.threadId,
          engineMessageId: record.engineMessageId ?? null,
          startedAt: record.startedAt,
        },
      });
  }

  async delete(key: {
    channelType: string;
    conversationKey: string;
    messageId: string;
  }): Promise<void> {
    await this.db
      .delete(channelActiveStreams)
      .where(
        and(
          eq(channelActiveStreams.channelType, key.channelType),
          eq(channelActiveStreams.conversationKey, key.conversationKey),
          eq(channelActiveStreams.messageId, key.messageId),
        ),
      );
  }

  async listForChannel(channelType: string): Promise<ActiveStreamRecord[]> {
    const rows = await this.db
      .select()
      .from(channelActiveStreams)
      .where(eq(channelActiveStreams.channelType, channelType))
      .orderBy(channelActiveStreams.startedAt);
    return rows.map(toRecord);
  }

  async listStale(channelType: string, startedBefore: number): Promise<ActiveStreamRecord[]> {
    const rows = await this.db
      .select()
      .from(channelActiveStreams)
      .where(
        and(
          eq(channelActiveStreams.channelType, channelType),
          lt(channelActiveStreams.startedAt, startedBefore),
        ),
      )
      .orderBy(channelActiveStreams.startedAt);
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof channelActiveStreams.$inferSelect): ActiveStreamRecord {
  return {
    channelType: row.channelType,
    conversationKey: row.conversationKey,
    messageId: row.messageId,
    threadTs: row.threadTs,
    sessionId: row.sessionId,
    threadId: row.threadId,
    engineMessageId: row.engineMessageId ?? undefined,
    orgId: row.orgId,
    startedAt: row.startedAt,
  };
}

/** In-memory store for tests and for a host running without a database. */
export class MemoryActiveStreamStore implements ActiveStreamStore {
  private rows = new Map<string, ActiveStreamRecord>();

  private static key(k: { channelType: string; conversationKey: string; messageId: string }): string {
    return `${k.channelType}\u0000${k.conversationKey}\u0000${k.messageId}`;
  }

  async insert(record: ActiveStreamRecord): Promise<void> {
    this.rows.set(MemoryActiveStreamStore.key(record), { ...record });
  }

  async delete(key: { channelType: string; conversationKey: string; messageId: string }): Promise<void> {
    this.rows.delete(MemoryActiveStreamStore.key(key));
  }

  async listForChannel(channelType: string): Promise<ActiveStreamRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.channelType === channelType)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async listStale(channelType: string, startedBefore: number): Promise<ActiveStreamRecord[]> {
    return (await this.listForChannel(channelType)).filter((r) => r.startedAt < startedBefore);
  }

  /** Test affordance: how many streams are still recorded as open. */
  size(): number {
    return this.rows.size;
  }
}
