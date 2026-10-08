// Wakeup and lease contracts (spec 2026-10-08: sandbox scratch, wakeups, and
// leases). A wakeup tracks one background unit of work (a detached process,
// a watch, or a timer). A lease keeps a sandbox alive while a wakeup or an
// explicit hold needs it, independent of session activity.

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
  reason: string;
  createdAt: number;
  deadlineAt: number;
  releasedAt?: number;
  releaseCause?: LeaseReleaseCause;
}

/** Fields a store transition may patch on a wakeup, alongside status. */
export type WakeupPatch = Partial<
  Pick<Wakeup, "cause" | "exitCode" | "endedAt" | "logOffset" | "logTail" | "eventCount" | "execId" | "leaseId">
>;

export interface WakeupLimits {
  leaseMaxHours: number;
  timerMaxHours: number;
  perSession: number;
  watchMaxEventsPerHour: number;
}

export type WakeupCreateInput =
  | { kind: "process"; command: string; reason: string; deadlineHours: number }
  | { kind: "watch"; command: string; reason: string; maxHours: number }
  | { kind: "timer"; prompt: string; fireAt: number };

/** Host seam a tool context uses to create and manage wakeups and leases. */
export interface WakeupsSeam {
  limits: WakeupLimits;
  create(threadId: string, input: WakeupCreateInput): Promise<{ wakeup: Wakeup; lease?: Lease }>;
  hold(input: { hours: number; reason: string }): Promise<Lease>;
  get(id: string): Promise<Wakeup | null>;
  list(): Promise<{ wakeups: Wakeup[]; leases: Lease[] }>;
  cancel(id: string): Promise<{ kind: "wakeup" | "lease" } | null>;
  readLog(id: string, offset: number, bytes: number): Promise<{ text: string; nextOffset: number; eof: boolean }>;
}
