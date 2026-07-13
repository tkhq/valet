import { StaleAttemptError } from "../../errors.js";
import type {
  BusEvent,
  DeliveredBusEvent,
  EventFilter,
  EventStream,
  StoredBusEvent,
  Unsubscribe,
  WriteFence,
} from "../../types.js";

interface Subscription {
  filter: EventFilter;
  callback: (event: DeliveredBusEvent) => void;
}

export interface InMemoryEventStreamOpts {
  /**
   * Decision 12: sync fence validation, typically `store.isCurrentAttempt`.
   * When absent, fenced appends are accepted unconditionally — validation
   * requires wiring a fenceCheck (documented on EventStream.append).
   */
  fenceCheck?: (fence: WriteFence) => boolean;
}

function matches(filter: EventFilter, event: BusEvent): boolean {
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false;
  if (filter.userId && filter.userId !== event.userId) return false;
  if (filter.eventTypes && !filter.eventTypes.includes(event.event.type)) return false;
  return true;
}

function formatOffset(n: number): string {
  return String(n).padStart(16, "0");
}

export class InMemoryEventStream implements EventStream {
  private logs = new Map<string, StoredBusEvent[]>();
  private keyToOffset = new Map<string, Map<string, string>>();
  private counters = new Map<string, number>();
  private subs = new Set<Subscription>();

  constructor(private readonly opts?: InMemoryEventStreamOpts) {}

  async append(event: BusEvent, eventKey: string, fence?: WriteFence): Promise<{ offset: string }> {
    if (fence && this.opts?.fenceCheck && !this.opts.fenceCheck(fence)) {
      throw new StaleAttemptError(fence.itemId, fence.attemptId, undefined);
    }

    let keys = this.keyToOffset.get(event.sessionId);
    if (!keys) {
      keys = new Map();
      this.keyToOffset.set(event.sessionId, keys);
    }
    const existing = keys.get(eventKey);
    if (existing !== undefined) {
      return { offset: existing };
    }

    const n = (this.counters.get(event.sessionId) ?? 0) + 1;
    this.counters.set(event.sessionId, n);
    const offset = formatOffset(n);
    keys.set(eventKey, offset);

    const stored: StoredBusEvent = { ...event, offset };
    let log = this.logs.get(event.sessionId);
    if (!log) {
      log = [];
      this.logs.set(event.sessionId, log);
    }
    log.push(stored);

    for (const sub of this.subs) {
      if (matches(sub.filter, stored)) sub.callback(stored);
    }

    return { offset };
  }

  async read(
    sessionId: string,
    opts?: { fromOffset?: string; limit?: number },
  ): Promise<{ events: StoredBusEvent[]; nextOffset: string }> {
    const log = this.logs.get(sessionId) ?? [];
    const fromOffset = opts?.fromOffset;
    let filtered = fromOffset === undefined ? log : log.filter((e) => e.offset > fromOffset);

    if (opts?.limit !== undefined) {
      filtered = filtered.slice(0, opts.limit);
    }

    const nextOffset =
      filtered.length > 0
        ? (filtered[filtered.length - 1]?.offset ?? "")
        : (fromOffset ?? "");

    return { events: filtered, nextOffset };
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
    const log = this.logs.get(sessionId);
    if (!log) return 0;
    const toDelete = new Set(queueItemIds);
    const before = log.length;
    const survivors = log.filter((e) => !e.queueItemId || !toDelete.has(e.queueItemId));
    this.logs.set(sessionId, survivors);
    return before - survivors.length;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.logs.delete(sessionId);
    this.keyToOffset.delete(sessionId);
    this.counters.delete(sessionId);
  }
}
