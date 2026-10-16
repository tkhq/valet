// Wakeup and lease contracts (spec 2026-10-08: sandbox scratch, wakeups, and
// leases). A wakeup tracks one background unit of work: a detached process,
// a watch, a timer, or an event waiter (spec 2026-10-15: event wakeups). A
// lease keeps a sandbox alive while a wakeup or an explicit hold needs it,
// independent of session activity.

import type { ChannelOrigin, CredentialProvider } from "../types.js";

/** What kind of background work a wakeup tracks. */
export type WakeupKind = "process" | "watch" | "timer" | "event";

/**
 * One entry of an event waiter's `on` list (spec 2026-10-15, Part C). Every
 * field except `key` narrows the match.
 */
export interface EventClause {
  /** The event key, such as `github.check_run.completed`. */
  key: string;
  /** Match only these normalized statuses. */
  status?: string[];
  /** Match only an update whose previous status is one of these. */
  from_status?: string[];
  /** Match only this actor login. */
  actor?: string;
  /** False drops events from bot actors. */
  bots?: boolean;
  /** True keeps events whose actor is in the waiter's `self` set. */
  include_self?: boolean;
}

/** What an event waiter matches, stored as `match_json`. */
export interface EventMatchSpec {
  clauses: EventClause[];
  /** True: the first match ends the waiter. False: stream mode. */
  once: boolean;
  /** External actor ids the session acts as. Their events are dropped unless a clause sets `include_self`. */
  self: string[];
  /**
   * Stream mode: the shortest gap between two `event.matched` signals (ms).
   * Absent means `WakeupLimits.watchMinIntervalMs`.
   */
  minIntervalMs?: number;
}

/** The most bytes of `EventMatchDigest.text` a store keeps (INV-E7). */
export const EVENT_DIGEST_TEXT_MAX_BYTES = 4096;

/** The most digests an event waiter buffers. `appendEventMatch` refuses past it. */
export const EVENT_BUFFER_MAX_DIGESTS = 200;

/** The most delivered dedupe keys an event waiter remembers, newest kept (INV-E4). */
export const EVENT_SEEN_MAX_KEYS = 256;

/** The bounded record of one matched event that an event waiter holds until delivery. */
export interface EventMatchDigest {
  key: string;
  status?: string;
  previousStatus?: string;
  subjects: string[];
  summary: string;
  url?: string;
  /** The actor's login. */
  actor?: string;
  /** ISO 8601 time of the event. */
  occurredAt: string;
  /** Unique per event. A waiter buffers one digest per `dedupeKey` (INV-E4). */
  dedupeKey: string;
  /** The message or comment body, at most `EVENT_DIGEST_TEXT_MAX_BYTES` bytes. */
  text?: string;
  /** The derived key the WakeWatcher must resolve before delivery. */
  derive?: string;
}

/** Lifecycle status of a wakeup. Terminal: done, cancelled, expired, lost. */
export type WakeupStatus = "pending" | "running" | "done" | "cancelled" | "expired" | "lost";

/** Why a wakeup ended or fired. */
export type WakeupCause =
  | "exit"
  | "deadline"
  | "cancelled"
  | "pid_missing"
  | "sandbox_unavailable"
  | "rate"
  | "fired";

export interface Wakeup {
  id: string;
  sessionId: string;
  threadId: string;
  kind: WakeupKind;
  status: WakeupStatus;
  reason: string;
  command?: string;
  prompt?: string;
  execId?: string;
  leaseId?: string;
  fireAt?: number;
  deadlineAt?: number;
  exitCode?: number;
  cause?: WakeupCause;
  logOffset: number;
  logTail: string;
  eventCount: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** The channel origin of the turn that created it. Signals carry it with `reply: "manual"`. */
  origin?: ChannelOrigin;
  /** `watch`: start of the current rate window (ms). */
  windowStartAt?: number;
  /** `watch`: poll ticks with new output in the current rate window (fix wave 3, M1). */
  windowCount?: number;
  /** `watch`: complete lines read but not yet sent, coalesced until the next emit. "" when empty. */
  watchBuffer?: string;
  /** `watch`: when the last `watch.event` went out (ms). */
  lastEmitAt?: number;
  /** `event`: the subjects the waiter waits on. */
  subjects?: string[];
  /** `event`: the clauses, the mode, and the self set. */
  eventMatch?: EventMatchSpec;
  /** `event`: matched digests awaiting delivery. Delivery removes them by dedupe key. */
  eventBuffer?: EventMatchDigest[];
  /**
   * `event`: the dedupe keys of the newest delivered digests, oldest first,
   * at most `EVENT_SEEN_MAX_KEYS`. Only `removeEventMatches` writes it.
   */
  eventSeen?: string[];
}

/** What kind of owner holds a lease open. */
export type LeaseOwnerKind = "process" | "watch" | "hold";

/** Why a lease was released. */
export type LeaseReleaseCause = "owner_ended" | "cancelled" | "deadline";

export interface Lease {
  id: string;
  sessionId: string;
  sandboxId?: string;
  ownerKind: LeaseOwnerKind;
  ownerId?: string;
  /** The thread that created it. `lease.expired` goes there. */
  threadId?: string;
  /** The channel origin of the turn that created it. */
  origin?: ChannelOrigin;
  reason: string;
  createdAt: number;
  deadlineAt: number;
  releasedAt?: number;
  releaseCause?: LeaseReleaseCause;
}

/** Keyset position for paging `listDueWakeups` in (createdAt, id) order. */
export interface WakeupCursor {
  createdAt: number;
  id: string;
}

/** Fields a store transition may patch on a wakeup, alongside status. */
export type WakeupPatch = Partial<
  Pick<
    Wakeup,
    "cause" | "exitCode" | "endedAt" | "logOffset" | "logTail" | "eventCount" | "execId"
    | "leaseId"
    | "windowStartAt"
    | "windowCount"
    | "watchBuffer"
    | "lastEmitAt"
    | "eventBuffer"
  >
>;

/** One `countWakeupsByKindAndStatus` group. */
export interface WakeupCount {
  kind: WakeupKind;
  status: WakeupStatus;
  count: number;
}

export interface WakeupLimits {
  leaseMaxHours: number;
  timerMaxHours: number;
  perSession: number;
  watchMaxEventsPerHour: number;
  /**
   * Shortest gap between two `watch.event` signals of one watch (ms). Lines
   * read in between are buffered and sent together. Absent means the
   * default, `DEFAULT_WATCH_MIN_INTERVAL_MS` (fix wave 3, M1).
   */
  watchMinIntervalMs?: number;
}

/** Default `WakeupLimits.watchMinIntervalMs`: one signal per two minutes. */
export const DEFAULT_WATCH_MIN_INTERVAL_MS = 120_000;

/**
 * The start of the line a provider appends to a detached job's log when
 * the log cap drops output: `[valet: log capped at <n> bytes; later output
 * dropped]` (fix wave 3, k8s M-B). Readers look for this prefix.
 */
export const JOB_LOG_CAPPED_MARKER = "[valet: log capped at ";

/** The full marker line for a cap of `bytes`, newline-terminated. */
export function jobLogCappedLine(bytes: number): string {
  return `${JOB_LOG_CAPPED_MARKER}${bytes} bytes; later output dropped]\n`;
}

export type WakeupCreateInput = (
  | { kind: "process"; command: string; reason: string; deadlineHours: number }
  | { kind: "watch"; command: string; reason: string; maxHours: number }
  | { kind: "timer"; prompt: string; fireAt: number }
  | { kind: "event"; subjects: string[]; match: EventMatchSpec; reason: string; maxHours: number }
) & {
  /** The calling turn's channel origin (`ToolContext.origin`). */
  origin?: ChannelOrigin;
};

export interface HoldInput {
  hours: number;
  reason: string;
  /** The thread that asked. `lease.expired` goes there. */
  threadId?: string;
  origin?: ChannelOrigin;
}

/** One thread's view of its session's background work (fix wave 2, M14). */
export interface WakeupsListing {
  /** This thread's pending and running wakeups. */
  wakeups: Wakeup[];
  /** This thread's active leases. A process or watch lease also appears through its wakeup. */
  leases: Lease[];
  /** Pending or running wakeups and active hold leases of the session's other threads. */
  otherThreads: number;
}

/**
 * A validated `wait_for_event` call (spec 2026-10-15, Part D). `subject` is
 * the raw input, a URL or a subject; the host's arm checks parse it.
 */
export interface ArmEventRequest {
  subject: string;
  on: EventClause[];
  once: boolean;
  reason: string;
  maxHours: number;
  /** Stream mode only: the shortest gap between two signals (ms). */
  minIntervalMs?: number;
}

/** What `WakeupsSeam.armEvent` returns: the new event waiter, or the refusal text the tool returns. */
export type ArmEventResult = { wakeup: Wakeup } | { refused: string };

/** Host seam a tool context uses to create and manage wakeups and leases. */
export interface WakeupsSeam {
  limits: WakeupLimits;
  create(threadId: string, input: WakeupCreateInput): Promise<{ wakeup: Wakeup; lease?: Lease }>;
  hold(input: HoldInput): Promise<Lease>;
  get(id: string): Promise<Wakeup | null>;
  /** The background work of `threadId`, plus a count for the session's other threads. */
  list(threadId: string): Promise<WakeupsListing>;
  /** Null for an unknown, ended, or foreign id. `refused` carries the text the tool returns. */
  cancel(id: string): Promise<{ kind: "wakeup" | "lease" } | { kind: "refused"; text: string } | null>;
  /**
   * `tail` reads the last `bytes` of the log instead of reading forward from
   * `offset`. `capped` is true when the provider dropped output at its log
   * cap without writing the marker line (docker).
   */
  readLog(
    id: string,
    offset: number,
    bytes: number,
    opts?: { tail?: boolean },
  ): Promise<{ text: string; nextOffset: number; eof: boolean; capped?: boolean }>;
  /**
   * Runs the arm checks (spec 2026-10-15, Part D1) and creates an event
   * waiter. Absent on a session that cannot wait for events, such as a
   * workflow run. `credentials` is the calling turn's credential provider:
   * the arm checks read the subject with it (INV-E1).
   */
  armEvent?(
    threadId: string,
    req: ArmEventRequest,
    origin?: ChannelOrigin,
    credentials?: CredentialProvider,
  ): Promise<ArmEventResult>;
}
