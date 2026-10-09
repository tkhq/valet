// Helpers the wakeups seam and the WakeWatcher share (spec 2026-10-08,
// fix wave 2): which errors mean the sandbox is gone. The detached job log
// cap lives in providers/sandbox-backend.ts. Also the human surface over
// background work (fix wave 2, group C): the listing the routes show, and
// the human cancel of spec B6.

import {
  recordWakeupSignalLost,
  SandboxEvictedError,
  SandboxGoneError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import { tail, WATCH_BUFFER_BYTES } from "./wake-watcher-decide.js";
import type {
  Lease,
  PromptContent,
  PromptOptions,
  SessionStore,
  Wakeup,
  WakeupKind,
  WakeupsSeam,
} from "@valet/engine";

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

/** One piece of open background work, as a refusal names it and a cancel targets it. */
export interface BlockingWork {
  /** `wk_` for a wakeup, `ls_` for a hold. A process or watch lease shows as its wakeup. */
  id: string;
  kind: WakeupKind | "hold";
  reason: string;
  threadId?: string;
  deadlineAt?: number;
  fireAt?: number;
  createdAt: number;
}

/** Which background work a route stops or a refusal names. */
export interface BackgroundWorkFilter {
  /** Only the work of this thread. A hold with no thread belongs to no single thread and stays. */
  threadId?: string;
  /** Only work that holds a lease: process, watch, and hold. Timers keep their schedule. */
  leasedOnly?: boolean;
  /** Only these ids. A route passes the work the caller can see. */
  ids?: ReadonlySet<string>;
}

/**
 * The work in `work` that `filter` selects: open wakeups (a process or watch
 * stands for its lease) and active holds.
 */
export function selectWork(work: BackgroundWork, filter: BackgroundWorkFilter): BlockingWork[] {
  const inThread = (threadId: string | undefined) => filter.threadId === undefined || threadId === filter.threadId;
  const picked = (id: string) => filter.ids === undefined || filter.ids.has(id);
  const wakeups: BlockingWork[] = work.wakeups
    .filter((w) => inThread(w.threadId) && !(filter.leasedOnly && w.kind === "timer") && picked(w.id))
    .map((w) => ({
      id: w.id,
      kind: w.kind,
      reason: w.reason,
      threadId: w.threadId,
      ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
      ...(w.fireAt !== undefined ? { fireAt: w.fireAt } : {}),
      createdAt: w.createdAt,
    }));
  const holds: BlockingWork[] = work.leases
    .filter((l) => l.ownerKind === "hold" && inThread(l.threadId) && picked(l.id))
    .map((l) => ({
      id: l.id,
      kind: "hold",
      reason: l.reason,
      ...(l.threadId !== undefined ? { threadId: l.threadId } : {}),
      deadlineAt: l.deadlineAt,
      createdAt: l.createdAt,
    }));
  return [...wakeups, ...holds];
}

/** An action that stops background work, and the words its refusal uses. */
export type BackgroundWorkAction = "pause" | "replace" | "profile" | "move" | "archive";

const ACTION_WORDS: Record<BackgroundWorkAction, { scope: "session" | "thread"; verb: string }> = {
  pause: { scope: "session", verb: "pause the session" },
  replace: { scope: "session", verb: "replace the sandbox" },
  profile: { scope: "session", verb: "change the profile" },
  move: { scope: "session", verb: "move the session" },
  archive: { scope: "thread", verb: "archive the thread" },
};

function describeWork(w: BlockingWork): string {
  if (w.kind === "timer" && w.fireAt !== undefined) {
    return `"${w.reason}" (timer, fires ${new Date(w.fireAt).toISOString()})`;
  }
  const deadline = w.deadlineAt !== undefined ? `, deadline ${new Date(w.deadlineAt).toISOString()}` : "";
  return `"${w.reason}" (${w.kind}${deadline})`;
}

/**
 * The 409 text of an action that would stop background work (fix wave 3,
 * group C). It names only the work the caller can see and counts the rest.
 * `forceAllowed` false means a retry with force cannot help, so the text
 * says what to do instead.
 */
export function backgroundWorkRefusal(
  action: BackgroundWorkAction,
  visible: readonly BlockingWork[],
  hiddenCount: number,
  forceAllowed: boolean,
): string {
  const { scope, verb } = ACTION_WORDS[action];
  const parts: string[] = [];
  if (visible.length > 0) {
    parts.push(`This ${scope} has background work running: ${visible.map(describeWork).join("; ")}.`);
  }
  if (hiddenCount > 0) {
    const items = hiddenCount === 1 ? "1 item runs" : `${hiddenCount} items run`;
    parts.push(
      visible.length > 0
        ? `${items} on threads you cannot see.`
        : `This ${scope} has background work running: ${items} on threads you cannot see.`,
    );
  }
  if (hiddenCount > 0) {
    parts.push(`Ask the people in those threads to cancel it, then ${verb}.`);
  } else if (forceAllowed) {
    parts.push(`Cancel it first, or retry with force=true to stop it and ${verb}.`);
  } else {
    parts.push(`Ask a session admin to cancel it, then ${verb}.`);
  }
  return parts.join(" ");
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
  /**
   * Where the signal goes. `work-thread` (the default) is the thread that
   * started the work. `main` is the session's main thread: a forced archive
   * uses it, because the work's own thread is about to be hidden.
   */
  deliverTo?: "work-thread" | "main";
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

/**
 * A deferred signal send. It submits into `target` when given, else into
 * the session the cancel ran on. A route that rebuilt the engine session
 * between the cancel and the send passes the new one. Never rejects.
 */
export type DeferredSignal = (target?: HumanCancelSession) => Promise<void>;

export type HumanCancelResult =
  | {
      kind: "cancelled";
      work: CancelledWork;
      /** With `signal: "defer"`: sends the terminal signal. */
      sendSignal?: DeferredSignal;
    }
  | { kind: "not_found" };

/** Sends now, returns the send for `defer`, or does nothing for `suppress`. */
async function routeSignal(
  opts: HumanCancelOptions,
  send: DeferredSignal,
): Promise<{ sendSignal?: DeferredSignal }> {
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
  // A watch's buffered lines reached no watch.event. Up to 64 KiB of them
  // follow the last output (fix wave 4, data N2).
  const unsent =
    row.kind === "watch" && row.watchBuffer
      ? `\n\nLines the watch read but did not send yet:\n${tail(row.watchBuffer, WATCH_BUFFER_BYTES)}`
      : "";
  return {
    kind: "signal",
    signalType: `${row.kind}.exited`,
    body: `A person stopped this ${row.kind} at ${at}. ${opts.note ?? DEFAULT_CANCEL_NOTE}${lastOutput}${unsent}`,
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
  const { origin, dispatchId, kind } = target;
  const threadId = opts.deliverTo === "main" ? undefined : target.threadId;
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
    const routed = await routeSignal(opts, (target) =>
      deliverCancelSignal(
        target ?? session,
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
  const routed = await routeSignal(opts, (target) =>
    deliverCancelSignal(
      target ?? session,
      { threadId: row.threadId, origin: row.origin, dispatchId: `wakeup:${row.id}:terminal`, kind: row.kind },
      signal,
      opts,
    ),
  );
  return { kind: "cancelled", work: { id, kind: row.kind, reason: row.reason, threadId: row.threadId }, ...routed };
}

/** What `cancelAllWorkAsHuman` cancelled, and with `defer`, the signal sends. */
export interface CancelAllResult {
  cancelled: CancelledWork[];
  /**
   * Sends every deferred signal, into `target` when given. A no-op unless
   * `signal` was `defer`. Never rejects.
   */
  sendSignals(target?: HumanCancelSession): Promise<void>;
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
  const ids = selectWork(await listBackgroundWork(engineStore, sessionId), filter).map((w) => w.id);
  const cancelled: CancelledWork[] = [];
  const sends: DeferredSignal[] = [];
  for (const id of ids) {
    const result = await cancelWorkAsHuman(engineStore, session, sessionId, id, opts);
    if (result.kind !== "cancelled") continue;
    cancelled.push(result.work);
    if (result.sendSignal) sends.push(result.sendSignal);
  }
  return {
    cancelled,
    async sendSignals(target) {
      for (const send of sends) await send(target);
    },
  };
}
