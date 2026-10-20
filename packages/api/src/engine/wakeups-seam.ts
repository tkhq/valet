import { recordWakeupEnded } from "@valet/engine";
import type {
  ArmEventRequest,
  ArmEventResult,
  ChannelOrigin,
  CredentialProvider,
  EventMatchSpec,
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
import { DEFAULT_JOB_LOG_MAX_BYTES } from "../providers/sandbox-backend.js";
import type { ArmCheckResult } from "../events/waiter-arm.js";
import type { EventWaiterDerive } from "../events/derive.js";
import { derivedClausesAccept } from "../events/waiter-match.js";
import { isSandboxGone } from "./wakeups-admin.js";

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
    /** The applied resource overrides from the last observation, or null. */
    observedResources?(): { scratch?: string } | null;
  };
}

export interface WakeupsSeamDeps {
  engineStore: SessionStore;
  limits: WakeupLimits;
  /** Restores a lease's sandbox for a best-effort kill or a log read when the session holds no ready handle. */
  provider?: Pick<SandboxProvider, "restore">;
  /** Records a terminal transition in `valet.wakeups.total`. Tests inject a spy. */
  recordEnded?: (kind: WakeupKind, cause: WakeupCause) => void;
  /**
   * Cap on a detached job's log, from `VALET_JOB_LOG_MAX_BYTES`. The host
   * resolves it once at boot, so a bad value stops the boot instead of
   * every session build (fix wave 3, data M3). Absent means 2 GiB.
   */
  jobLogMaxBytes?: number;
  /**
   * The session's `/scratch` size in bytes, or undefined without scratch.
   * Job logs live on `/scratch` when it exists, so each log is capped at a
   * quarter of it: a log can then never fill `/scratch` and evict the pod
   * alone (fix wave 3, k8s M-B).
   */
  scratchBytes?: () => number | undefined;
  now?: () => number;
  /** Evaluate plugin hooks after the checked waiter is stored. */
  evaluateEvent?: EventWaiterDerive;
  nudge?: (ids: string[]) => void;
  /**
   * Runs the `wait_for_event` arm checks (spec 2026-10-15, Part D1) for
   * this session. Absent for a workflow run: the seam then has no
   * `armEvent`, and the tool returns R9.
   */
  checkArm?: (
    threadId: string,
    req: ArmEventRequest,
    credentials: CredentialProvider | undefined,
  ) => Promise<ArmCheckResult>;
}

const BASH_BACKGROUND_UNAVAILABLE =
  "[bash_background] This sandbox backend cannot run background processes. Run the command in the foreground with a timeout of up to 3600 seconds.";
const HOLD_NOT_RUNNING = "[hold_sandbox] The sandbox is not running. Send a command that needs it first, then hold it.";
const READ_NOT_RUNNING =
  "[process_read] The sandbox is not running, so the log is gone with it. The process.exited signal kept the last 4 KB of output, and files in /workspace remain.";

const HOUR_MS = 3_600_000;

const EVENT_CREATE_REFUSAL =
  "[wait_for_event] Event waiters start only through the wait_for_event tool. Call wait_for_event with the subject and clauses.";

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
  const jobLogMaxBytes = deps.jobLogMaxBytes ?? DEFAULT_JOB_LOG_MAX_BYTES;

  /** The detached log cap: the deploy cap, or a quarter of `/scratch` when that is smaller. */
  function logCap(): number {
    const scratch = deps.scratchBytes?.();
    return scratch === undefined ? jobLogMaxBytes : Math.min(jobLogMaxBytes, Math.max(1, Math.floor(scratch / 4)));
  }

  /**
   * True when the session was deleted while a create wrote its rows. A
   * delete that committed first leaves nothing to remove them, so the
   * caller runs the delete cascade again (fix wave 3 and 4, data probable 2).
   */
  async function sessionGone(): Promise<boolean> {
    return (await engineStore.getSession(sessionId)) === null;
  }

  /**
   * Deletes the rows a create wrote after its session was deleted. The
   * session delete cascade is idempotent: it removes every wakeup and lease
   * row of the id and counts each open wakeup in `valet.wakeups.total`.
   */
  async function deleteLateRows(rows: { wakeupId?: string; leaseId?: string }): Promise<void> {
    // Only the rows this create wrote: a same-id session that appears in
    // this window keeps its history (fix wave 4 re-review, F4).
    await engineStore.deleteWakeupRows(sessionId, rows);
  }

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
    if (await sessionGone()) {
      await deleteLateRows({ wakeupId: pending.id, leaseId: lease.id });
      throw new Error("[bash_background] This session was deleted, so the command did not start.");
    }

    let handle;
    try {
      handle = await sb.execJob(command, { detached: true, execId, maxOutputBytes: logCap() });
    } catch (err) {
      // A raw sandbox with no job mode starts nothing. End the row with no
      // pid_missing count and give the refusal the agent can act on (fix
      // wave 4, UX N12).
      if (err instanceof Error && err.message.startsWith("[job_unsupported]")) {
        const endedAt = now();
        await engineStore
          .transitionWakeupAndReleaseLease(wakeupId, ["pending"], "lost", { cause: "pid_missing", endedAt }, endedAt, "owner_ended")
          .catch((storeErr: unknown) => {
            console.error(`wakeups: ending ${wakeupId} after a refused start failed; the WakeWatcher ends it:`, storeErr);
          });
        throw new Error(BASH_BACKGROUND_UNAVAILABLE);
      }
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

    let running: Wakeup | null;
    try {
      running = await engineStore.transitionWakeup(wakeupId, ["pending"], "running", { execId: handle.execId }, now());
    } catch (err) {
      // The job runs and the pending row names its exec id. The WakeWatcher
      // probes the row past its start grace and adopts the job, so the
      // agent must not run the command again (fix wave 3, concurrency L6).
      console.error(`wakeups: marking ${wakeupId} running failed; the WakeWatcher adopts it after its start grace:`, err);
      return { wakeup: { ...pending, execId: handle.execId }, lease };
    }
    if (!running) {
      const current = await engineStore.getWakeup(wakeupId).catch(() => null);
      // The WakeWatcher adopted the job while the start ran: the row tracks
      // it (running, or already ended with its exit), so it is started and
      // must not be killed or run again (fix wave 4, UX N4 and F8).
      if (current?.status === "running" || current?.status === "done") {
        return { wakeup: current, lease };
      }
      // Another writer ended the pending row while the start ran. Nothing
      // tracks this job now, so stop it.
      await killJob(wakeupId, handle.execId, sandboxId);
      if (current?.status === "cancelled") {
        throw new Error(`[bash_background] ${wakeupId} was cancelled before it started, so it was stopped. Do not start it again unless someone asks.`);
      }
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
    if (await sessionGone()) {
      await deleteLateRows({ wakeupId: wakeup.id });
      throw new Error("[wake_at] This session was deleted, so the timer was not set.");
    }
    return { wakeup };
  }

  /**
   * Creates a running event waiter (spec 2026-10-15, Part C). It holds no
   * lease (INV-E3), so the sandbox may hibernate while it waits. The
   * WakeWatcher ends it at `deadlineAt`.
   */
  async function createEvent(
    threadId: string,
    subjects: string[],
    match: EventMatchSpec,
    reason: string,
    maxHours: number,
    origin: ChannelOrigin | undefined,
  ): Promise<{ wakeup: Wakeup }> {
    if (!(maxHours > 0) || maxHours > limits.timerMaxHours) {
      throw new Error(`[wait_for_event] Set max_hours (1 to ${limits.timerMaxHours}).`);
    }
    const nowMs = now();
    const wakeup: Wakeup = {
      id: newWakeupId(),
      sessionId,
      threadId,
      kind: "event",
      status: "running",
      reason,
      deadlineAt: nowMs + maxHours * HOUR_MS,
      logOffset: 0,
      logTail: "",
      eventCount: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
      subjects,
      eventMatch: match,
      eventBuffer: [],
      ...(origin !== undefined ? { origin } : {}),
    };
    await engineStore.createWakeup(wakeup);
    if (await sessionGone()) {
      await deleteLateRows({ wakeupId: wakeup.id });
      throw new Error("[wait_for_event] This session was deleted, so the wait was not set.");
    }
    return { wakeup };
  }

  const checkArm = deps.checkArm;
  const armEvent = checkArm
    ? async (
      threadId: string,
      req: ArmEventRequest,
      origin?: ChannelOrigin,
      credentials?: CredentialProvider,
    ): Promise<ArmEventResult> => {
      const checked = await checkArm(threadId, req, credentials);
      if (!checked.ok) return { refused: checked.text };
      const match: EventMatchSpec = {
        clauses: req.on,
        once: req.once,
        self: checked.self,
        ...(req.endOnClose !== undefined ? { endOnClose: req.endOnClose } : {}),
        ...(req.minIntervalMs !== undefined ? { minIntervalMs: req.minIntervalMs } : {}),
        ...(checked.primarySubject !== undefined ? { primarySubject: checked.primarySubject } : {}),
      };
      try {
        const result = await createEvent(threadId, checked.subjects, match, req.reason, req.maxHours, origin);
        if (checked.resolveBranch) {
          const branch = checked.primarySubject;
          const pullRequest = await checked.resolveBranch();
          if (branch && pullRequest) {
            const repository = branch.split(":branch/")[0]!;
            const bound = await engineStore.bindEventWaiter(result.wakeup.id, branch, pullRequest, repository, now());
            if (bound) console.info("[event-waiters] bound branch", { waiterId: bound.id, branch, pullRequest });
          }
          // A webhook can bind the row while the lookup runs.
          result.wakeup = await engineStore.getWakeup(result.wakeup.id) ?? result.wakeup;
        }
        if (req.evaluateCurrent !== false && deps.evaluateEvent) {
          for (const key of new Set(req.on.map((clause) => clause.key))) {
            const source = { key, derive: key, dedupeKey: `arm:${key}`, subjects: result.wakeup.subjects ?? [],
              summary: "Current subject state", occurredAt: new Date(now()).toISOString() };
            try {
              const outcome = await deps.evaluateEvent(result.wakeup, source, true);
              if (outcome.result === "error") console.warn("[event-waiters] arm evaluation failed", { waiterId: result.wakeup.id, key }, outcome.error);
              if (outcome.result === "event" && outcome.digest.status !== "pending" && derivedClausesAccept(match, key, outcome.digest)) {
                if (await engineStore.appendEventMatch(result.wakeup.id, outcome.digest, now())) deps.nudge?.([result.wakeup.id]);
              }
            } catch (error) {
              console.warn("[event-waiters] arm evaluation failed", { waiterId: result.wakeup.id, key }, error);
            }
          }
        }
        return { ...result, ...(checked.warning ? { warning: checked.warning } : {}) };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[wait_for_event]")) return { refused: err.message };
        throw err;
      }
    }
    : undefined;

  return {
    limits,
    ...(armEvent ? { armEvent } : {}),

    async create(threadId: string, input: WakeupCreateInput) {
      if (input.kind === "timer") {
        return createTimer(threadId, input.prompt, input.fireAt, input.origin);
      }
      if (input.kind === "event") {
        // Only `armEvent` creates event waiters, so every one passes the
        // arm checks (INV-E1).
        throw new Error(EVENT_CREATE_REFUSAL);
      }
      const hours = input.kind === "process" ? input.deadlineHours : input.maxHours;
      return createProcessOrWatch(threadId, input.kind, input.command, input.reason, hours, input.origin);
    },

    async hold(input: HoldInput): Promise<Lease> {
      assertLeaseHours(input.hours);
      // A hold on no sandbox protects nothing, and its unresolvable sandbox
      // would read as an unprotected lease (fix wave 2, M10). A hibernated
      // session keeps its sandbox id but runs no sandbox (fix wave 4, UX P4).
      const attachment = session()?.attachment;
      const running = attachment?.current() ?? null;
      const sandboxId = attachment?.sandboxId ?? running?.id;
      if (!running || sandboxId === undefined) throw new Error(HOLD_NOT_RUNNING);
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
      if (await sessionGone()) {
        await deleteLateRows({ leaseId: lease.id });
        throw new Error("[hold_sandbox] This session was deleted, so no hold was set.");
      }
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
        throw new Error(`[process_read] ${id} is not a background process or watch of this session. Call wakeup_list to see this thread's ids.`);
      }
      if (wakeup.kind === "event") {
        throw new Error(`[process_read] ${id} is an event waiter and has no log.`);
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
      // Docker drops output at its cap without a marker line and reports
      // `truncated` instead (fix wave 4, UX N5).
      const capped = poll.truncated ? { capped: true } : {};
      if (text.length < poll.output.length) {
        return { text, nextOffset: offset + Buffer.byteLength(text), eof: false, ...capped };
      }
      return { text, nextOffset: poll.nextOffset, eof: poll.status !== "running", ...capped };
    },
  };
}
