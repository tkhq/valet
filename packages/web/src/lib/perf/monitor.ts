import { budgetFor, type MeasurementKind } from "./budgets";

/** One timing, from a trigger to the paint that showed its result. */
export interface Measurement {
  kind: MeasurementKind;
  flow: string;
  ms: number;
  budget: number;
  /** `performance.now()` of the trigger. */
  at: number;
}

/** A fixed-size buffer that drops the oldest item when full. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray(): T[] {
    return [...this.items];
  }
  clear(): void {
    this.items.length = 0;
  }
}

export interface MonitorClock {
  now(): number;
  /** Calls `fn` after the next frame has painted. */
  afterPaint(fn: () => void): void;
}

/** Measurements kept for the overlay and the CI check. */
export const MEASUREMENT_CAPACITY = 200;
/** First-load queries one flow waits for. More than this, and the rest are not awaited. */
const PENDING_QUERY_CAP = 64;
/** A flow that has not settled by then is dropped, not recorded. */
export const FLOW_TIMEOUT_MS = 15_000;
/** Quiet frames after the last load before a flow counts as settled. The
 * recorded time is the first of them, so the wait does not add to it. */
const SETTLE_FRAMES = 2;
/** A navigation this soon after a press is timed from the press. */
const PRESS_TO_NAVIGATION_MS = 300;

interface ActiveFlow {
  name: string;
  start: number;
  /** False until the router has rendered the destination. Press flows start rendered. */
  rendered: boolean;
  /** Frames to wait before the flow may settle, so queries mounted by the render can register. */
  settleFrames: number;
  /** The first paint with nothing pending. Cleared when another load starts. */
  settledAt: number | undefined;
  pending: Set<string>;
}

/**
 * Collects interaction, route and data timings. It knows nothing about the
 * DOM or the router: `install.ts` feeds it events, and the tests feed it a
 * fake clock.
 */
export class PerfMonitor {
  private readonly measurements = new RingBuffer<Measurement>(MEASUREMENT_CAPACITY);
  private readonly listeners = new Set<(measurement: Measurement) => void>();
  private readonly clearListeners = new Set<() => void>();
  private flow: ActiveFlow | undefined;
  private lastPress: { at: number; name: string } | undefined;
  private changes = 0;

  constructor(private readonly clock: MonitorClock) {}

  /** Counts changes, for `useSyncExternalStore`. */
  revision(): number {
    return this.changes;
  }

  entries(): Measurement[] {
    return this.measurements.toArray();
  }

  clear(): void {
    this.measurements.clear();
    this.flow = undefined;
    this.lastPress = undefined;
    this.changes += 1;
    for (const listener of this.clearListeners) listener();
  }

  /** Listens for finished measurements, and for a press whose time was raised. Returns the unsubscribe function. */
  subscribe(listener: (measurement: Measurement) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A click or key press on a control, at the event's timestamp. Records the
   * time to the next paint. A press on a `data-perf-flow` control also
   * starts a flow, so the data it loads is timed.
   */
  press(name: string, at: number, startsFlow: boolean): Measurement {
    this.lastPress = { at, name };
    if (startsFlow) this.begin(name, at, true);
    const measurement: Measurement = { kind: "interaction", flow: name, at, ms: 0, budget: budgetFor("interaction", name) };
    this.measurements.push(measurement);
    this.clock.afterPaint(() => {
      measurement.ms = Math.max(measurement.ms, this.clock.now() - at);
      this.emit(measurement);
    });
    return measurement;
  }

  /**
   * The browser's own timing for a press (Event Timing API), which also
   * counts input delay before handlers ran. Raises the matching press's
   * time when it is longer.
   */
  eventTiming(startTime: number, duration: number): void {
    const match = this.measurements.toArray().find((m) => m.kind === "interaction" && Math.abs(m.at - startTime) < 1);
    if (!match || duration <= match.ms) return;
    match.ms = duration;
    this.emit(match);
  }

  /** The router started a navigation. `name` is resolved later, at render. */
  navigationStart(): void {
    const now = this.clock.now();
    const press = this.lastPress && now - this.lastPress.at < PRESS_TO_NAVIGATION_MS ? this.lastPress : undefined;
    this.begin("", press?.at ?? now, false);
  }

  /** The router rendered the destination of the current navigation. */
  navigationRendered(name: string): void {
    const flow = this.flow;
    if (!flow || flow.rendered) return;
    flow.name = name;
    flow.rendered = true;
    this.clock.afterPaint(() => {
      if (this.flow !== flow) return;
      this.record("route", name, flow.start, this.clock.now());
      this.trySettle(flow);
    });
  }

  /** A query started its first load (no data yet) under the current flow. */
  queryLoading(hash: string): void {
    const flow = this.flow;
    if (!flow || flow.pending.size >= PENDING_QUERY_CAP) return;
    flow.pending.add(hash);
    flow.settledAt = undefined;
    flow.settleFrames = SETTLE_FRAMES;
  }

  /** A query's load finished, with data or an error. */
  querySettled(hash: string): void {
    const flow = this.flow;
    if (!flow || !flow.pending.delete(hash)) return;
    this.trySettle(flow);
  }

  private begin(name: string, start: number, rendered: boolean): void {
    // A newer trigger replaces an unsettled flow: its timing would mix both.
    const flow: ActiveFlow = { name, start, rendered, settleFrames: SETTLE_FRAMES, settledAt: undefined, pending: new Set() };
    this.flow = flow;
    if (rendered) this.trySettle(flow);
  }

  private trySettle(flow: ActiveFlow): void {
    if (this.flow !== flow || !flow.rendered || flow.pending.size > 0) return;
    if (this.clock.now() - flow.start > FLOW_TIMEOUT_MS) {
      this.flow = undefined;
      return;
    }
    this.clock.afterPaint(() => {
      if (this.flow !== flow || flow.pending.size > 0) return;
      flow.settledAt ??= this.clock.now();
      if (flow.settleFrames > 0) {
        flow.settleFrames -= 1;
        this.trySettle(flow);
        return;
      }
      this.flow = undefined;
      this.record("data", flow.name, flow.start, flow.settledAt);
    });
  }

  private record(kind: MeasurementKind, flow: string, at: number, end: number): Measurement {
    const measurement: Measurement = { kind, flow, at, ms: end - at, budget: budgetFor(kind, flow) };
    this.measurements.push(measurement);
    this.emit(measurement);
    return measurement;
  }

  /** Listens for `clear()`. Returns the unsubscribe function. */
  onClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  private emit(measurement: Measurement): void {
    this.changes += 1;
    for (const listener of this.listeners) listener(measurement);
  }
}
