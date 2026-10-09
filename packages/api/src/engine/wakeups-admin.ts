// Helpers the wakeups seam and the WakeWatcher share (spec 2026-10-08,
// fix wave 2): which errors mean the sandbox is gone, and the detached job
// log cap. Also the human surface over background work (fix wave 2, group
// C): the listing the routes show, and the human cancel of spec B6.

import {
  recordWakeupSignalLost,
  SandboxEvictedError,
  SandboxGoneError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import type {
  Lease,
  PromptContent,
  PromptOptions,
  SessionStore,
  Wakeup,
  WakeupKind,
  WakeupsSeam,
} from "@valet/engine";
import { parseResourceQuantity } from "@valet/shared";

/**
 * Error texts that mean the sandbox is gone: the kubernetes provider's
 * pod-gone error (`podUnavailableError`) and its `restore()` miss for a
 * deleted CR. Docker restore errors arrive as `SandboxGoneError`.
 */
const SANDBOX_GONE = /No such container|backing pod was recreated or removed|Sandbox CR "[^"]*" not found/;

/**
 * True when `err` means the wakeup's sandbox no longer exists or no longer
 * runs, so its process is gone with it (fix wave 2, M2). An evicted pod
 * counts: the eviction killed every process in it.
 */
export function isSandboxGone(err: unknown): boolean {
  if (
    err instanceof SandboxUnavailableError ||
    err instanceof SandboxSupersededError ||
    err instanceof SandboxEvictedError ||
    err instanceof SandboxGoneError
  ) {
    return true;
  }
  return err instanceof Error && SANDBOX_GONE.test(err.message);
}

/** Default cap on one detached job's log: 2 GiB (fix wave 2, M6). */
export const DEFAULT_JOB_LOG_MAX_BYTES = 2 * 1024 ** 3;

/**
 * The detached job log cap from `VALET_JOB_LOG_MAX_BYTES`: a plain byte
 * count or a quantity such as `2Gi`. Unset means the default. A value that
 * does not parse to a positive whole number of bytes stops the boot.
 */
export function resolveJobLogMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.VALET_JOB_LOG_MAX_BYTES?.trim();
  if (raw === undefined || raw === "") return DEFAULT_JOB_LOG_MAX_BYTES;
  const bytes = /^\d+$/.test(raw) ? Number(raw) : parseResourceQuantity(raw);
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(
      `VALET_JOB_LOG_MAX_BYTES="${raw}" is not a byte size. Set a whole number of bytes or a quantity such as 2Gi.`,
    );
  }
  return bytes;
}

// ── Human surface (fix wave 2, group C) ─────────────────────────────────────

/** A session's background work as a person sees it: open wakeups and active leases. */
export interface BackgroundWork {
  /** Pending and running wakeups of every kind. */
  wakeups: Wakeup[];
  /** Active leases. A process or watch lease also appears through its wakeup. */
  leases: Lease[];
}

/** Every open wakeup and active lease of `sessionId`. */
export async function listBackgroundWork(engineStore: SessionStore, sessionId: string): Promise<BackgroundWork> {
  const [wakeups, leases] = await Promise.all([
    engineStore.listWakeups(sessionId, ["pending", "running"]),
    engineStore.listActiveLeases(sessionId),
  ]);
  return { wakeups, leases };
}

/**
 * The 409 text of a route that would stop the sandbox under active leases
 * (pause and replace, fix wave 2 B8). Null when the session holds no lease.
 * A process or watch lease shows its wakeup id, which is the id a person or
 * the agent cancels.
 */
export async function activeLeaseRefusal(engineStore: SessionStore, sessionId: string): Promise<string | null> {
  if ((await engineStore.countActiveLeases(sessionId)) === 0) return null;
  const leases = await engineStore.listActiveLeases(sessionId);
  if (leases.length === 0) return null;
  const items = leases
    .map((l) => `${l.ownerId ?? l.id} "${l.reason}" (deadline ${new Date(l.deadlineAt).toISOString()})`)
    .join("; ");
  return `This session has active background work: ${items}. Ask the agent to cancel it, or send force=true to stop it.`;
}

type SignalContent = Extract<PromptContent, { kind: "signal" }>;

/** The slice of an engine `Session` a human cancel uses. Every real `Session` fits it. */
export interface HumanCancelSession {
  options: { wakeups?: WakeupsSeam };
  prompt(content: PromptContent, opts: PromptOptions): Promise<unknown>;
  /** The loaded thread with this id, or null. */
  threadById(id: string): object | null;
}

export interface HumanCancelOptions {
  /** The person who cancels. Signals carry `cancelledBy=user:<id>`. */
  actorUserId: string;
  /**
   * `deliver` sends the spec B6 terminal signal with `cause=cancelled`.
   * `suppress` sends none. Thread archive suppresses it: the thread is
   * hidden, and the main thread can belong to other people. Owner move
   * suppresses it: a signal turn would run as the new owner. `defer`
   * returns the send as `sendSignal`, so a route can stop the sandbox
   * first and only then start the signal turn (pause, replace).
   */
  signal: "deliver" | "suppress" | "defer";
  /** One sentence the signal body adds, such as why the person stopped the work. */
  note?: string;
  now?: () => number;
  /** Counts a signal that failed to submit. Tests inject a spy. */
  signalLost?: (kind: WakeupKind | "hold") => void;
}

/** One piece of background work a person cancelled. */
export interface CancelledWork {
  id: string;
  kind: WakeupKind | "hold";
  reason: string;
  threadId?: string;
}

export type HumanCancelResult =
  | {
      kind: "cancelled";
      work: CancelledWork;
      /** With `signal: "defer"`: sends the terminal signal. Never rejects. */
      sendSignal?: () => Promise<void>;
    }
  | { kind: "not_found" };

/** Sends now, returns the send for `defer`, or does nothing for `suppress`. */
async function routeSignal(
  opts: HumanCancelOptions,
  send: () => Promise<void>,
): Promise<{ sendSignal?: () => Promise<void> }> {
  if (opts.signal === "deliver") await send();
  return opts.signal === "defer" ? { sendSignal: send } : {};
}

const DEFAULT_CANCEL_NOTE = "Do not start it again unless someone asks.";

function wakeupCancelledSignal(row: Wakeup, opts: HumanCancelOptions, nowMs: number): SignalContent {
  const at = new Date(nowMs).toISOString();
  const attributes: Record<string, string> = {
    wakeupId: row.id,
    kind: row.kind,
    reason: row.reason,
    cause: "cancelled",
    cancelledBy: `user:${opts.actorUserId}`,
  };
  if (row.kind === "timer") {
    if (row.fireAt !== undefined) attributes.scheduledAt = new Date(row.fireAt).toISOString();
    return {
      kind: "signal",
      signalType: "timer.cancelled",
      body: `A person cancelled this scheduled wakeup at ${at}, before it fired. Do not run its prompt unless someone asks.`,
      attributes,
      tagName: "wakeup",
    };
  }
  attributes.durationSeconds = String(Math.round((nowMs - row.createdAt) / 1000));
  const lastOutput = row.logTail ? `\n\nLast output:\n${row.logTail}` : "";
  return {
    kind: "signal",
    signalType: `${row.kind}.exited`,
    body: `A person stopped this ${row.kind} at ${at}. ${opts.note ?? DEFAULT_CANCEL_NOTE}${lastOutput}`,
    attributes,
    tagName: "wakeup",
  };
}

function holdReleasedSignal(lease: Lease, opts: HumanCancelOptions, nowMs: number): SignalContent {
  return {
    kind: "signal",
    signalType: "lease.released",
    body: `A person released hold "${lease.reason}" at ${new Date(nowMs).toISOString()}. The sandbox can now stop when it is idle.`,
    attributes: {
      leaseId: lease.id,
      kind: "hold",
      reason: lease.reason,
      cause: "cancelled",
      cancelledBy: `user:${opts.actorUserId}`,
    },
    tagName: "wakeup",
  };
}

/**
 * Submits one human-cancel signal to `threadId`, or to the main thread when
 * the session has no such thread (spec B5). The channel origin rides along
 * with manual replies, as in the WakeWatcher. A failed submit is logged and
 * counted; the cancel already happened.
 */
async function deliverCancelSignal(
  session: HumanCancelSession,
  target: { threadId: string | undefined; origin: Wakeup["origin"]; dispatchId: string; kind: WakeupKind | "hold" },
  content: SignalContent,
  opts: HumanCancelOptions,
): Promise<void> {
  const { threadId, origin, dispatchId, kind } = target;
  const signal: SignalContent = origin !== undefined ? { ...content, origin: { ...origin, reply: "manual" } } : content;
  const base: PromptOptions = { dispatchId, queueMode: "followup" };
  try {
    if (threadId !== undefined && session.threadById(threadId)) {
      await session.prompt(signal, { threadId, ...base });
    } else {
      await session.prompt(signal, base);
    }
  } catch (err) {
    (opts.signalLost ?? recordWakeupSignalLost)(kind);
    console.error(`wakeups: the human-cancel signal ${dispatchId} failed to submit; the work is already cancelled:`, err);
  }
}

/**
 * Cancels one wakeup (`wk_`) or hold lease (`ls_`) of `sessionId` for a
 * person (spec B6, fix wave 2 H8). The seam's cancel does the CAS, the lease
 * release, and the best-effort kill. Then, unless the caller suppresses it,
 * the terminal signal tells the agent that a person stopped the work. A
 * process or watch lease id resolves to its wakeup. `not_found` covers an
 * unknown, foreign, or already-ended id.
 */
export async function cancelWorkAsHuman(
  engineStore: SessionStore,
  session: HumanCancelSession,
  sessionId: string,
  id: string,
  opts: HumanCancelOptions,
): Promise<HumanCancelResult> {
  const seam = session.options.wakeups;
  if (!seam) throw new Error(`session ${sessionId} has no wakeups seam, so its background work cannot be cancelled`);
  const now = opts.now ?? (() => Date.now());

  if (id.startsWith("ls_")) {
    const lease = (await engineStore.listActiveLeases(sessionId)).find((l) => l.id === id);
    if (!lease) return { kind: "not_found" };
    if (lease.ownerKind !== "hold") {
      return lease.ownerId ? cancelWorkAsHuman(engineStore, session, sessionId, lease.ownerId, opts) : { kind: "not_found" };
    }
    const outcome = await seam.cancel(id);
    if (outcome?.kind !== "lease") return { kind: "not_found" };
    const signal = holdReleasedSignal(lease, opts, now());
    const routed = await routeSignal(opts, () =>
      deliverCancelSignal(
        session,
        { threadId: lease.threadId, origin: lease.origin, dispatchId: `lease:${lease.id}:released`, kind: "hold" },
        signal,
        opts,
      ),
    );
    return {
      kind: "cancelled",
      work: { id, kind: "hold", reason: lease.reason, ...(lease.threadId !== undefined ? { threadId: lease.threadId } : {}) },
      ...routed,
    };
  }

  const row = await engineStore.getWakeup(id);
  if (!row || row.sessionId !== sessionId || (row.status !== "pending" && row.status !== "running")) {
    return { kind: "not_found" };
  }
  const outcome = await seam.cancel(id);
  // A lost CAS means the WakeWatcher ended the row first. Its own signal stands.
  if (outcome?.kind !== "wakeup") return { kind: "not_found" };
  const signal = wakeupCancelledSignal(row, opts, now());
  const routed = await routeSignal(opts, () =>
    deliverCancelSignal(
      session,
      { threadId: row.threadId, origin: row.origin, dispatchId: `wakeup:${row.id}:terminal`, kind: row.kind },
      signal,
      opts,
    ),
  );
  return { kind: "cancelled", work: { id, kind: row.kind, reason: row.reason, threadId: row.threadId }, ...routed };
}

/** Which background work `cancelAllWorkAsHuman` cancels. */
export interface BackgroundWorkFilter {
  /** Only the work of this thread. A hold with no thread belongs to no single thread and stays. */
  threadId?: string;
  /** Only work that holds a lease: process, watch, and hold. Timers keep their schedule. */
  leasedOnly?: boolean;
}

/** What `cancelAllWorkAsHuman` cancelled, and with `defer`, the signal sends. */
export interface CancelAllResult {
  cancelled: CancelledWork[];
  /** Sends every deferred signal. A no-op unless `signal` was `defer`. Never rejects. */
  sendSignals(): Promise<void>;
}

/**
 * Cancels every open wakeup and active hold of `sessionId` that `filter`
 * selects, one human cancel each. An item the WakeWatcher ended first is not
 * in the result.
 */
export async function cancelAllWorkAsHuman(
  engineStore: SessionStore,
  session: HumanCancelSession,
  sessionId: string,
  filter: BackgroundWorkFilter,
  opts: HumanCancelOptions,
): Promise<CancelAllResult> {
  const { wakeups, leases } = await listBackgroundWork(engineStore, sessionId);
  const inThread = (threadId: string | undefined) => filter.threadId === undefined || threadId === filter.threadId;
  const ids = [
    ...wakeups.filter((w) => inThread(w.threadId) && !(filter.leasedOnly && w.kind === "timer")).map((w) => w.id),
    ...leases.filter((l) => l.ownerKind === "hold" && inThread(l.threadId)).map((l) => l.id),
  ];
  const cancelled: CancelledWork[] = [];
  const sends: Array<() => Promise<void>> = [];
  for (const id of ids) {
    const result = await cancelWorkAsHuman(engineStore, session, sessionId, id, opts);
    if (result.kind !== "cancelled") continue;
    cancelled.push(result.work);
    if (result.sendSignal) sends.push(result.sendSignal);
  }
  return {
    cancelled,
    async sendSignals() {
      for (const send of sends) await send();
    },
  };
}
