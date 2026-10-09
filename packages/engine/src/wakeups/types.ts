// Wakeup and lease contracts (spec 2026-10-08: sandbox scratch, wakeups, and
// leases). A wakeup tracks one background unit of work (a detached process,
// a watch, or a timer). A lease keeps a sandbox alive while a wakeup or an
// explicit hold needs it, independent of session activity.

import type { ChannelOrigin } from "../types.js";

/** What kind of background work a wakeup tracks. */
export type WakeupKind = "process" | "watch" | "timer";

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
  /** `watch`: `watch.event` signals emitted in the current rate window. */
  windowCount?: number;
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
    "cause" | "exitCode" | "endedAt" | "logOffset" | "logTail" | "eventCount" | "execId" | "leaseId" | "windowStartAt" | "windowCount"
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
}

export type WakeupCreateInput = (
  | { kind: "process"; command: string; reason: string; deadlineHours: number }
  | { kind: "watch"; command: string; reason: string; maxHours: number }
  | { kind: "timer"; prompt: string; fireAt: number }
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
  /** `tail` reads the last `bytes` of the log instead of reading forward from `offset`. */
  readLog(
    id: string,
    offset: number,
    bytes: number,
    opts?: { tail?: boolean },
  ): Promise<{ text: string; nextOffset: number; eof: boolean }>;
}
