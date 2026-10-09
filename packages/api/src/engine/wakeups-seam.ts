import { recordWakeupEnded } from "@valet/engine";
import type {
  ChannelOrigin,
  HoldInput,
  Lease,
  Sandbox,
  SandboxProvider,
  SessionStore,
  Wakeup,
  WakeupCause,
  WakeupCreateInput,
  WakeupKind,
  WakeupLimits,
  WakeupsListing,
  WakeupsSeam,
} from "@valet/engine";
import { newExecId, newLeaseId, newWakeupId } from "@valet/engine/wakeups-ids";
import { isSandboxGone, resolveJobLogMaxBytes } from "./wakeups-admin.js";

/**
 * The slice of a live session the wakeups seam needs: the sandbox's job
 * API and the attachment's sandbox id and raw handle. Narrower than the
 * full engine `Session` class on purpose. `Session.attachment` is a
 * `SandboxAttachment` with private fields, so a test fixture cannot build
 * one without instantiating the real engine. Every real `Session` is
 * structurally assignable to this type, so `host.ts` passes `() =>
 * builtSession` straight through with no cast.
 */
export interface WakeupsSeamSession {
  sandbox: Sandbox;
  attachment: {
    sandboxId?: string;
    /** The ready sandbox, or null. Reading it never provisions or wakes compute. */
    current(): Sandbox | null;
  };
}

export interface WakeupsSeamDeps {
  engineStore: SessionStore;
  limits: WakeupLimits;
  /** Restores a lease's sandbox for a best-effort kill or a log read when the session holds no ready handle. */
  provider?: Pick<SandboxProvider, "restore">;
  /** Records a terminal transition in `valet.wakeups.total`. Tests inject a spy. */
  recordEnded?: (kind: WakeupKind, cause: WakeupCause) => void;
  /** Cap on a detached job's log. Defaults to `VALET_JOB_LOG_MAX_BYTES` (2 GiB). */
  jobLogMaxBytes?: number;
  now?: () => number;
}

const BASH_BACKGROUND_UNAVAILABLE = "[bash_background] this sandbox backend cannot run background processes.";
const HOLD_NO_SANDBOX = "[hold_sandbox] No sandbox is running. Start work that needs the sandbox first.";
const READ_NOT_RUNNING = "[process_read] the sandbox is not running; the log is gone with it.";

const HOUR_MS = 3_600_000;

/**
 * Builds the `ToolContext.wakeups` seam for one session (Task 15,
 * spec 2026-10-08). The seam is the only path the engine's background-work
 * tools (`bash background`, `watch`, `wake_at`, `hold_sandbox`,
 * `process_read`, `wakeup_list`, `wakeup_cancel`) use to reach the store
 * and the sandbox's job API. Every id it accepts must belong to this
 * session: an id from another session reads as unknown (spec B3).
 */
export function buildWakeupsSeam(
  deps: WakeupsSeamDeps,
  sessionId: string,
  session: () => WakeupsSeamSession | undefined,
): WakeupsSeam {
  const { engineStore, limits } = deps;
  const now = deps.now ?? (() => Date.now());
  const recordEnded = deps.recordEnded ?? recordWakeupEnded;
  const jobLogMaxBytes = deps.jobLogMaxBytes ?? resolveJobLogMaxBytes(process.env);

  /**
   * INV-1: a lease deadline is at most `leaseMaxHours` after creation. The
   * tool validators bound the hours first. This guard is the invariant's
   * single owner, because the stores take no limits configuration.
   */
  function assertLeaseHours(hours: number): void {
    if (!(hours > 0) || hours > limits.leaseMaxHours) {
      throw new Error(
        `[lease_limit] A lease of ${hours}h exceeds sandbox.leaseMaxHours (${limits.leaseMaxHours}h). Request between 1 and ${limits.leaseMaxHours} hours.`,
      );
    }
  }

  /** This session's wakeup with `id`, or null for an unknown or foreign id. */
  async function ownWakeup(id: string): Promise<Wakeup | null> {
    const wakeup = await engineStore.getWakeup(id);
    return wakeup && wakeup.sessionId === sessionId ? wakeup : null;
  }

  async function activeLease(leaseId: string | undefined): Promise<Lease | undefined> {
    if (leaseId === undefined) return undefined;
    return (await engineStore.listActiveLeases(sessionId)).find((l) => l.id === leaseId);
  }

  /**
   * The raw sandbox that runs a job: the session's ready handle, or a
   * restored handle for `sandboxId`. Never the policy sandbox, which can
   * provision or wake compute on a cold session. Null when neither exists.
   */
  async function rawSandbox(sandboxId: string | undefined): Promise<Sandbox | null> {
    const live = session()?.attachment.current() ?? null;
    if (live && (sandboxId === undefined || sandboxId === live.id)) return live;
    if (sandboxId === undefined || !deps.provider) return null;
    return deps.provider.restore(sandboxId);
  }

  /** Best-effort kill of a process or watch group. A failure never blocks the caller. */
  async function killJob(wakeupId: string, execId: string, sandboxId: string | undefined): Promise<void> {
    try {
      const target = await rawSandbox(sandboxId);
      await target?.cancelJob?.(execId);
    } catch (err) {
      console.warn(`wakeup_cancel: kill of ${wakeupId} (exec ${execId}) failed; the row is already ended:`, err);
    }
  }

  async function createProcessOrWatch(
    threadId: string,
    kind: "process" | "watch",
    command: string,
    reason: string,
    hours: number,
    origin: ChannelOrigin | undefined,
  ): Promise<{ wakeup: Wakeup; lease: Lease }> {
    assertLeaseHours(hours);
    const sb = session()?.sandbox;
    if (!sb?.execJob) {
      throw new Error(BASH_BACKGROUND_UNAVAILABLE);
    }
    const nowMs = now();
    const wakeupId = newWakeupId();
    const execId = newExecId();
    const sandboxId = session()?.attachment.sandboxId;
    const lease: Lease = {
      id: newLeaseId(),
      sessionId,
      sandboxId,
      ownerKind: kind,
      ownerId: wakeupId,
      threadId,
      ...(origin !== undefined ? { origin } : {}),
      reason,
      createdAt: nowMs,
      deadlineAt: nowMs + hours * HOUR_MS,
    };
    const pending: Wakeup = {
      id: wakeupId,
      sessionId,
      threadId,
      kind,
      status: "pending",
      reason,
      command,
      execId,
      leaseId: lease.id,
      deadlineAt: lease.deadlineAt,
      logOffset: 0,
      logTail: "",
      eventCount: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
      ...(origin !== undefined ? { origin } : {}),
    };
    // Rows first, in one transaction, then the job (fix wave 2, B2 and H10).
    // A crash after this write leaves a pending row the WakeWatcher ends as
    // lost and kills; it never leaves a process that no row tracks.
    await engineStore.createWakeupWithLease(pending, lease);

    let handle;
    try {
      handle = await sb.execJob(command, { detached: true, execId, maxOutputBytes: jobLogMaxBytes });
    } catch (err) {
      // The start may or may not have run the command. End the row and its
      // lease, and kill the requested id in case it did.
      const endedAt = now();
      const ended = await engineStore
        .transitionWakeupAndReleaseLease(wakeupId, ["pending"], "lost", { cause: "pid_missing", endedAt }, endedAt, "owner_ended")
        .catch((storeErr: unknown) => {
          console.error(`wakeups: ending ${wakeupId} after a failed start failed; the WakeWatcher ends it:`, storeErr);
          return null;
        });
      if (ended) recordEnded(kind, "pid_missing");
      await killJob(wakeupId, execId, sandboxId);
      throw err;
    }

    const running = await engineStore.transitionWakeup(wakeupId, ["pending"], "running", { execId: handle.execId }, now());
    if (!running) {
      // The WakeWatcher ended the pending row while the start ran (a start
      // past its grace). Nothing tracks this job now, so stop it.
      await killJob(wakeupId, handle.execId, sandboxId);
      throw new Error(`[bash_background] The start of ${wakeupId} took too long, so it was stopped. Run the command again.`);
    }
    // The start can provision the sandbox, so its id may be known only now.
    const startedOn = session()?.attachment.sandboxId;
    if (sandboxId === undefined && startedOn !== undefined) {
      try {
        if (await engineStore.setLeaseSandboxId(lease.id, startedOn)) lease.sandboxId = startedOn;
      } catch (err) {
        console.warn(`wakeups: recording sandbox ${startedOn} on lease ${lease.id} failed; the WakeWatcher records it:`, err);
      }
    }
    return { wakeup: running, lease };
  }

  async function createTimer(
    threadId: string,
    prompt: string,
    fireAt: number,
    origin: ChannelOrigin | undefined,
  ): Promise<{ wakeup: Wakeup }> {
    const nowMs = now();
    const wakeup: Wakeup = {
      id: newWakeupId(),
      sessionId,
      threadId,
      kind: "timer",
      status: "pending",
      reason: prompt.slice(0, 80),
      prompt,
      fireAt,
      logOffset: 0,
      logTail: "",
      eventCount: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
      ...(origin !== undefined ? { origin } : {}),
    };
    await engineStore.createWakeup(wakeup);
    return { wakeup };
  }

  return {
    limits,

    async create(threadId: string, input: WakeupCreateInput) {
      if (input.kind === "timer") {
        return createTimer(threadId, input.prompt, input.fireAt, input.origin);
      }
      const hours = input.kind === "process" ? input.deadlineHours : input.maxHours;
      return createProcessOrWatch(threadId, input.kind, input.command, input.reason, hours, input.origin);
    },

    async hold(input: HoldInput): Promise<Lease> {
      assertLeaseHours(input.hours);
      const sandboxId = session()?.attachment.sandboxId;
      // A hold on no sandbox protects nothing, and its unresolvable sandbox
      // would read as an unprotected lease (fix wave 2, M10).
      if (sandboxId === undefined) throw new Error(HOLD_NO_SANDBOX);
      const nowMs = now();
      const lease: Lease = {
        id: newLeaseId(),
        sessionId,
        sandboxId,
        ownerKind: "hold",
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        reason: input.reason,
        createdAt: nowMs,
        deadlineAt: nowMs + input.hours * HOUR_MS,
      };
      await engineStore.createLease(lease);
      return lease;
    },

    async get(id: string): Promise<Wakeup | null> {
      return ownWakeup(id);
    },

    async list(threadId: string): Promise<WakeupsListing> {
      const [wakeups, leases] = await Promise.all([
        engineStore.listWakeups(sessionId, ["pending", "running"]),
        engineStore.listActiveLeases(sessionId),
      ]);
      // A lease written before leases had a thread belongs to every thread.
      const mine = (l: Lease) => l.threadId === undefined || l.threadId === threadId;
      const otherWakeups = wakeups.filter((w) => w.threadId !== threadId).length;
      const otherHolds = leases.filter((l) => l.ownerKind === "hold" && !mine(l)).length;
      return {
        wakeups: wakeups.filter((w) => w.threadId === threadId),
        leases: leases.filter(mine),
        otherThreads: otherWakeups + otherHolds,
      };
    },

    async cancel(id: string) {
      const nowMs = now();
      if (id.startsWith("wk_")) {
        const wakeup = await ownWakeup(id);
        if (!wakeup) return null;
        // Read the lease before the release: the kill needs its sandbox id.
        const lease = await activeLease(wakeup.leaseId);
        // CAS first, with the lease release in the same statement (spec B5,
        // fix wave 2 M1). A lost CAS kills nothing, so a watcher that ended
        // the row first keeps its exit signal and its cause.
        const patch = { cause: "cancelled" as const, endedAt: nowMs };
        const transitioned = wakeup.leaseId
          ? await engineStore.transitionWakeupAndReleaseLease(id, ["running", "pending"], "cancelled", patch, nowMs, "cancelled")
          : await engineStore.transitionWakeup(id, ["running", "pending"], "cancelled", patch, nowMs);
        if (!transitioned) return null;
        recordEnded(wakeup.kind, "cancelled");
        if ((wakeup.kind === "process" || wakeup.kind === "watch") && wakeup.execId) {
          await killJob(wakeup.id, wakeup.execId, lease?.sandboxId);
        }
        return { kind: "wakeup" as const };
      }
      if (id.startsWith("ls_")) {
        const lease = await activeLease(id);
        if (!lease) return null;
        if (lease.ownerKind !== "hold") {
          // Releasing a process or watch lease alone would leave its wakeup
          // running with no lease. The wakeup id ends both.
          const owner = lease.ownerId ?? "its wakeup";
          return {
            kind: "refused" as const,
            text: `[wakeup_cancel] ${id} belongs to ${lease.ownerKind} ${owner}. Cancel ${owner} instead; that stops the ${lease.ownerKind} and releases this lease.`,
          };
        }
        const released = await engineStore.releaseLease(id, "cancelled", nowMs);
        return released ? { kind: "lease" as const } : null;
      }
      return null;
    },

    async readLog(id: string, offset: number, bytes: number, opts?: { tail?: boolean }) {
      const wakeup = await ownWakeup(id);
      if (!wakeup) {
        throw new Error(`[process_read] ${id} is not a wakeup of this thread. Call wakeup_list to see this thread's ids.`);
      }
      if (!wakeup.execId) {
        throw new Error(
          `[process_read] ${id} is a timer and has no log. Only a background process or watch has a log.`,
        );
      }
      // The raw handle only: reading a log must never wake or provision a
      // sandbox, whose new pod would hold no log (fix wave 2, M15).
      const lease = await activeLease(wakeup.leaseId);
      const sandboxId = lease?.sandboxId ?? (await engineStore.getSession(sessionId))?.sandboxId;
      let target: Sandbox | null;
      try {
        target = await rawSandbox(sandboxId);
      } catch (err) {
        if (isSandboxGone(err)) throw new Error(READ_NOT_RUNNING);
        throw err;
      }
      if (!target) throw new Error(READ_NOT_RUNNING);
      if (!target.pollJob) {
        throw new Error("[process_read] this sandbox backend cannot read background logs.");
      }
      let poll;
      try {
        poll = await target.pollJob(wakeup.execId, offset, { maxBytes: bytes, ...(opts?.tail ? { tail: true } : {}) });
      } catch (err) {
        if (isSandboxGone(err)) throw new Error(READ_NOT_RUNNING);
        throw err;
      }
      // A provider that ignores the bound returns more. Cut it here.
      const text = poll.output.slice(0, bytes);
      if (text.length < poll.output.length) {
        return { text, nextOffset: offset + Buffer.byteLength(text), eof: false };
      }
      return { text, nextOffset: poll.nextOffset, eof: poll.status !== "running" };
    },
  };
}
