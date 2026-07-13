import type Database from "better-sqlite3";
import { ValidationError } from "@valet/engine";
import type {
  BusEvent,
  DeliveredBusEvent,
  EventFilter,
  EventStream,
  StoredBusEvent,
  Unsubscribe,
} from "@valet/engine";

interface Subscription {
  filter: EventFilter;
  callback: (event: DeliveredBusEvent) => void;
}

/** Raw column shape of a `SELECT * FROM engine_events` row. */
interface EventRow {
  session_id: string;
  seq: number;
  event_key: string;
  thread_id: string | null;
  queue_item_id: string | null;
  user_id: string | null;
  event_type: string;
  payload: string;
  timestamp: number;
}

function formatOffset(seq: number): string {
  return String(seq).padStart(16, "0");
}

/** Parses an inbound `fromOffset` string into the integer `seq` it addresses. */
function parseOffset(offset: string): number {
  const n = Number(offset);
  if (!Number.isSafeInteger(n)) {
    throw new ValidationError(`invalid fromOffset: ${JSON.stringify(offset)}`);
  }
  return n;
}

function matches(filter: EventFilter, event: BusEvent): boolean {
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false;
  if (filter.userId && filter.userId !== event.userId) return false;
  if (filter.eventTypes && !filter.eventTypes.includes(event.event.type)) return false;
  return true;
}

function rowToStoredEvent(row: EventRow): StoredBusEvent {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id ?? undefined,
    queueItemId: row.queue_item_id ?? undefined,
    userId: row.user_id ?? undefined,
    // The payload is the full EngineEvent as persisted by `append`.
    event: JSON.parse(row.payload) as BusEvent["event"],
    timestamp: row.timestamp,
    offset: formatOffset(row.seq),
  };
}

const SELECT_BY_KEY_SQL = `SELECT seq FROM engine_events WHERE session_id = ? AND event_key = ?`;

const INSERT_SQL = `
  INSERT INTO engine_events
    (session_id, seq, event_key, thread_id, queue_item_id, user_id, event_type, payload, timestamp)
  VALUES
    (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM engine_events WHERE session_id = ?), ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Offset-addressed, durable `EventStream` over the raw better-sqlite3 handle
 * shared with `SqliteSessionStore`. Live fan-out to subscribers is in-process
 * only — callers (API layer) must share a single instance across WS
 * subscribers and the engine for delivery to work.
 */
export class SqliteEventStream implements EventStream {
  private subs = new Set<Subscription>();

  constructor(private readonly sqlite: Database.Database) {}

  async append(event: BusEvent, eventKey: string): Promise<{ offset: string }> {
    const appendTxn = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(SELECT_BY_KEY_SQL).get(event.sessionId, eventKey) as
        | { seq: number }
        | undefined;
      if (existing) {
        return { seq: existing.seq, inserted: false };
      }
      this.sqlite
        .prepare(INSERT_SQL)
        .run(
          event.sessionId,
          event.sessionId,
          eventKey,
          event.threadId ?? null,
          event.queueItemId ?? null,
          event.userId ?? null,
          event.event.type,
          JSON.stringify(event.event),
          event.timestamp,
        );
      const inserted = this.sqlite.prepare(SELECT_BY_KEY_SQL).get(event.sessionId, eventKey) as { seq: number };
      return { seq: inserted.seq, inserted: true };
    });

    const { seq, inserted } = appendTxn.immediate();
    const offset = formatOffset(seq);

    // Fan out only after the transaction has committed, and only for events
    // that were actually newly appended (appendOnce dedup hits are silent).
    if (inserted) {
      const stored: StoredBusEvent = { ...event, offset };
      for (const sub of this.subs) {
        if (matches(sub.filter, stored)) sub.callback(stored);
      }
    }

    return { offset };
  }

  async read(
    sessionId: string,
    opts?: { fromOffset?: string; limit?: number },
  ): Promise<{ events: StoredBusEvent[]; nextOffset: string }> {
    const fromSeq = opts?.fromOffset !== undefined ? parseOffset(opts.fromOffset) : 0;
    const limit = opts?.limit ?? 500;
    const rows = this.sqlite
      .prepare(`SELECT * FROM engine_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(sessionId, fromSeq, limit) as EventRow[];
    const events = rows.map(rowToStoredEvent);
    const nextOffset = events.length > 0 ? (events[events.length - 1]?.offset ?? "") : (opts?.fromOffset ?? "");
    return { events, nextOffset };
  }

  subscribe(filter: EventFilter, callback: (event: DeliveredBusEvent) => void): Unsubscribe {
    const sub: Subscription = { filter, callback };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publishEphemeral(event: BusEvent): void {
    const delivered: DeliveredBusEvent = { ...event };
    for (const sub of this.subs) {
      if (matches(sub.filter, delivered)) sub.callback(delivered);
    }
  }

  async prune(sessionId: string, queueItemIds: string[]): Promise<number> {
    if (queueItemIds.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < queueItemIds.length; i += 500) {
      const chunk = queueItemIds.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const result = this.sqlite
        .prepare(`DELETE FROM engine_events WHERE session_id = ? AND queue_item_id IN (${placeholders})`)
        .run(sessionId, ...chunk);
      total += result.changes;
    }
    return total;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sqlite.prepare(`DELETE FROM engine_events WHERE session_id = ?`).run(sessionId);
  }
}
