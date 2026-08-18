import { StaleAttemptError, ValidationError } from "@valet/engine";
import type {
  BusEvent,
  DeliveredBusEvent,
  EventFilter,
  EventStream,
  StoredBusEvent,
  Unsubscribe,
  WriteFence,
} from "@valet/engine";
import { isPgUniqueViolation, type PgDb, type PgQueryable } from "./db.js";
import { asString, asStringOrNull, toNum } from "./helpers.js";

interface Subscription {
  filter: EventFilter;
  callback: (event: DeliveredBusEvent) => void;
}

/** Raw column shape of a `SELECT * FROM engine_events` row. */
interface EventRow {
  sessionId: string;
  seq: number;
  eventKey: string;
  threadId: string | null;
  queueItemId: string | null;
  userId: string | null;
  eventType: string;
  payload: string;
  timestamp: number;
}

/** Narrows a raw `engine_events` row (as returned by pg's query()) into an EventRow. */
function rawToEventRow(raw: Record<string, unknown>): EventRow {
  return {
    sessionId: asString(raw.session_id, "session_id"),
    // `seq` is DDL `integer` (not `bigint`), so node-postgres/PGlite already
    // hand it back as a JS number — `toNum` is a no-op passthrough here, kept
    // for uniformity with every other numeric column in this file.
    seq: toNum(raw.seq, "seq"),
    eventKey: asString(raw.event_key, "event_key"),
    threadId: asStringOrNull(raw.thread_id, "thread_id"),
    queueItemId: asStringOrNull(raw.queue_item_id, "queue_item_id"),
    userId: asStringOrNull(raw.user_id, "user_id"),
    eventType: asString(raw.event_type, "event_type"),
    payload: asString(raw.payload, "payload"),
    // `timestamp` is `bigint` — comes back as a string; must funnel through
    // `toNum` per decision 7 (ms-timestamp columns stay JS numbers on the TS
    // side).
    timestamp: toNum(raw.timestamp, "timestamp"),
  };
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
    sessionId: row.sessionId,
    threadId: row.threadId ?? undefined,
    queueItemId: row.queueItemId ?? undefined,
    userId: row.userId ?? undefined,
    // The payload is the full EngineEvent as persisted by `append`.
    event: JSON.parse(row.payload) as BusEvent["event"],
    timestamp: row.timestamp,
    offset: formatOffset(row.seq),
  };
}

const SELECT_BY_KEY_SQL = `SELECT seq FROM engine_events WHERE session_id = $1 AND event_key = $2`;

const INSERT_SQL = `
  INSERT INTO engine_events
    (session_id, seq, event_key, thread_id, queue_item_id, user_id, event_type, payload, timestamp)
  VALUES
    ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM engine_events WHERE session_id = $1), $2, $3, $4, $5, $6, $7, $8)
  RETURNING seq
`;

const PRUNE_CHUNK_SIZE = 500;

/**
 * Offset-addressed, durable `EventStream` over a shared `PgDb`. Live fan-out
 * to subscribers is in-process only — callers (API layer) must share a
 * single instance across WS subscribers and the engine for delivery to work.
 *
 * Seq allocation (decision 6 of
 * docs/specs/2026-07-15-postgres-backend-design.md, event-stream bullet):
 * SQLite's correctness came from the whole-database lock `BEGIN IMMEDIATE`
 * gave every write; Postgres gives row-level MVCC instead, so a
 * `SELECT ... FOR UPDATE` on the fenced queue-item row (as the fencing
 * bucket-2 methods use) does NOT cover `MAX(seq)+1` allocation — appends can
 * be fence-less (admin routes pass no fence) and a session can hold multiple
 * queue items, so two concurrent appends could lock different queue-item
 * rows (or no row at all) and race on the same `MAX(seq)+1` computation. The
 * translation: lock the session's own `engine_sessions` row instead — one
 * row that always exists for any valid session, giving per-session
 * serialization independent of which (if any) queue item is being appended
 * for. Belt-and-suspenders: the `(session_id, seq)` PRIMARY KEY means a
 * missed serialization surfaces as Postgres error `23505`
 * (unique_violation), which `append` retries the whole transaction once —
 * never silently swallowed. A second `23505` propagates to the caller.
 */
export class PgEventStream implements EventStream {
  private subs = new Set<Subscription>();

  constructor(private readonly db: PgDb) {}

  async append(event: BusEvent, eventKey: string, fence?: WriteFence): Promise<{ offset: string }> {
    const attempt = async (): Promise<{ seq: number; inserted: boolean }> => {
      return this.db.transaction(async (tx: PgQueryable) => {
        // Per-session serialization: lock the session row (always present)
        // BEFORE the fence check and the MAX(seq)+1 allocation, so concurrent
        // appends for the same session — fenced or not, same queue item or
        // not — serialize on this one row.
        await tx.query("SELECT id FROM engine_sessions WHERE id = $1 FOR UPDATE", [event.sessionId]);

        if (fence) {
          const result = await tx.query("SELECT attempt_id FROM engine_queue_items WHERE id = $1 FOR UPDATE", [
            fence.itemId,
          ]);
          const raw = result.rows[0];
          const attemptId = raw && typeof raw.attempt_id === "string" ? raw.attempt_id : undefined;
          if (!raw || attemptId !== fence.attemptId) {
            throw new StaleAttemptError(fence.itemId, fence.attemptId, attemptId);
          }
        }

        const existing = await tx.query(SELECT_BY_KEY_SQL, [event.sessionId, eventKey]);
        const existingRow = existing.rows[0];
        if (existingRow) {
          return { seq: toNum(existingRow.seq, "seq"), inserted: false };
        }

        const inserted = await tx.query(INSERT_SQL, [
          event.sessionId,
          eventKey,
          event.threadId ?? null,
          event.queueItemId ?? null,
          event.userId ?? null,
          event.event.type,
          JSON.stringify(event.event),
          event.timestamp,
        ]);
        const insertedRow = inserted.rows[0];
        if (!insertedRow) {
          throw new Error(`engine_events insert for session ${event.sessionId} returned no row`);
        }
        return { seq: toNum(insertedRow.seq, "seq"), inserted: true };
      });
    };

    let result: { seq: number; inserted: boolean };
    try {
      result = await attempt();
    } catch (err) {
      // Belt-and-suspenders retry: a missed serialization (should not happen
      // given the session-row lock above) surfaces as the (session_id, seq)
      // PK's 23505. Retry the whole transaction once; a second failure
      // propagates.
      if (isPgUniqueViolation(err)) {
        result = await attempt();
      } else {
        throw err;
      }
    }

    const offset = formatOffset(result.seq);

    // Fan out only after the transaction has committed, and only for events
    // that were actually newly appended (appendOnce dedup hits are silent).
    if (result.inserted) {
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
    const result = await this.db.query(
      `SELECT * FROM engine_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [sessionId, fromSeq, limit],
    );
    const events = result.rows.map(rawToEventRow).map(rowToStoredEvent);
    const nextOffset = events.length > 0 ? (events[events.length - 1]?.offset ?? "") : (opts?.fromOffset ?? "");
    return { events, nextOffset };
  }

  async readLatest(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<{ events: StoredBusEvent[]; nextOffset: string; hasMore: boolean }> {
    const limit = opts?.limit ?? 500;
    // One row over the limit answers `hasMore` without a second COUNT query:
    // the extra row exists only when older events do. It is dropped below.
    const result = await this.db.query(
      `SELECT * FROM engine_events WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`,
      [sessionId, limit + 1],
    );
    const descending = result.rows.map(rawToEventRow).map(rowToStoredEvent);
    const hasMore = descending.length > limit;
    // Reverse to offset order, so the page reads oldest first like `read`.
    const events = descending.slice(0, limit).reverse();
    const nextOffset = events[events.length - 1]?.offset ?? "";
    return { events, nextOffset, hasMore };
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
    // Chunk sized well under Postgres's 65535-parameter-per-query limit —
    // one param for session_id plus one per queue item id in the chunk.
    for (let i = 0; i < queueItemIds.length; i += PRUNE_CHUNK_SIZE) {
      const chunk = queueItemIds.slice(i, i + PRUNE_CHUNK_SIZE);
      const placeholders = chunk.map((_, idx) => `$${idx + 2}`).join(",");
      const result = await this.db.query(
        `DELETE FROM engine_events WHERE session_id = $1 AND queue_item_id IN (${placeholders})`,
        [sessionId, ...chunk],
      );
      total += result.rowCount;
    }
    return total;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.query(`DELETE FROM engine_events WHERE session_id = $1`, [sessionId]);
  }
}
