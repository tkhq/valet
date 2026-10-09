import { recordWakeupEnded } from "@valet/engine";
import type {
  Lease,
  Sandbox,
  SandboxProvider,
  SessionStore,
  Wakeup,
  WakeupCause,
  WakeupCreateInput,
  WakeupKind,
  WakeupLimits,
  WakeupsSeam,
} from "@valet/engine";
import { newLeaseId, newWakeupId } from "@valet/engine/wakeups-ids";

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
  /** Restores a lease's sandbox for a best-effort kill when the session holds no ready handle. */
  provider?: Pick<SandboxProvider, "restore">;
  /** Records an agent cancel in `valet.wakeups.total`. Tests inject a spy. */
  recordEnded?: (kind: WakeupKind, cause: WakeupCause) => void;
  now?: () => number;
}

const BASH_BACKGROUND_UNAVAILABLE = "[bash_background] this sandbox backend cannot run background processes.";

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

  /**
   * Best-effort kill of a process or watch group. It uses the raw ready
   * handle, or a restored one, never the policy sandbox: that path can
   * provision compute on a cold session. A failure never blocks the cancel.
   */
  async function killJob(wakeup: Wakeup, execId: string): Promise<void> {
    try {
      const lease = wakeup.leaseId === undefined
        ? undefined
        : (await engineStore.listActiveLeases(sessionId)).find((l) => l.id === wakeup.leaseId);
      const live = session()?.attachment.current() ?? null;
      let target: Sandbox | null = null;
      if (live && (lease?.sandboxId === undefined || lease.sandboxId === live.id)) {
        target = live;
      } else if (lease?.sandboxId !== undefined && deps.provider) {
        target = await deps.provider.restore(lease.sandboxId);
      }
      await target?.cancelJob?.(execId);
    } catch (err) {
      console.warn(`wakeup_cancel: kill of ${wakeup.id} (exec ${execId}) failed; cancelling the row anyway:`, err);
    }
  }

  async function createProcessOrWatch(
    threadId: string,
    kind: "process" | "watch",
    command: string,
    reason: string,
    hours: number,
  ): Promise<{ wakeup: Wakeup; lease: Lease }> {
    assertLeaseHours(hours);
    const sb = session()?.sandbox;
    if (!sb?.execJob) {
      throw new Error(BASH_BACKGROUND_UNAVAILABLE);
    }
    const nowMs = now();
    const wakeupId = newWakeupId();
    const handle = await sb.execJob(command, { detached: true });
    const lease: Lease = {
      id: newLeaseId(),
      sessionId,
      sandboxId: session()?.attachment.sandboxId,
      ownerKind: kind,
      ownerId: wakeupId,
      reason,
      createdAt: nowMs,
      deadlineAt: nowMs + hours * HOUR_MS,
    };
    // Lease first, then the wakeup: a crash between the two writes leaves a
    // lease with no wakeup, which the watcher expires at its deadline.
    await engineStore.createLease(lease);
    const wakeup: Wakeup = {
      id: wakeupId,
      sessionId,
      threadId,
      kind,
      status: "running",
      reason,
      command,
      execId: handle.execId,
      leaseId: lease.id,
      deadlineAt: lease.deadlineAt,
      logOffset: 0,
      logTail: "",
      eventCount: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await engineStore.createWakeup(wakeup);
    return { wakeup, lease };
  }

  async function createTimer(threadId: string, prompt: string, fireAt: number): Promise<{ wakeup: Wakeup }> {
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
    };
    await engineStore.createWakeup(wakeup);
    return { wakeup };
  }

  return {
    limits,

    async create(threadId: string, input: WakeupCreateInput) {
      if (input.kind === "timer") {
        return createTimer(threadId, input.prompt, input.fireAt);
      }
      const hours = input.kind === "process" ? input.deadlineHours : input.maxHours;
      return createProcessOrWatch(threadId, input.kind, input.command, input.reason, hours);
    },

    async hold(input: { hours: number; reason: string }): Promise<Lease> {
      assertLeaseHours(input.hours);
      const nowMs = now();
      const lease: Lease = {
        id: newLeaseId(),
        sessionId,
        sandboxId: session()?.attachment.sandboxId,
        ownerKind: "hold",
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

    async list() {
      const [wakeups, leases] = await Promise.all([
        engineStore.listWakeups(sessionId, ["pending", "running"]),
        engineStore.listActiveLeases(sessionId),
      ]);
      return { wakeups, leases };
    },

    async cancel(id: string) {
      const nowMs = now();
      if (id.startsWith("wk_")) {
        const wakeup = await ownWakeup(id);
        if (!wakeup) return null;
        if ((wakeup.kind === "process" || wakeup.kind === "watch") && wakeup.execId) {
          await killJob(wakeup, wakeup.execId);
        }
        const transitioned = await engineStore.transitionWakeup(
          id,
          ["running", "pending"],
          "cancelled",
          { cause: "cancelled", endedAt: nowMs },
          nowMs,
        );
        if (!transitioned) return null;
        recordEnded(wakeup.kind, "cancelled");
        if (wakeup.leaseId) {
          await engineStore.releaseLease(wakeup.leaseId, "cancelled", nowMs);
        }
        return { kind: "wakeup" as const };
      }
      if (id.startsWith("ls_")) {
        const lease = (await engineStore.listActiveLeases(sessionId)).find((l) => l.id === id);
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

    async readLog(id: string, offset: number, bytes: number) {
      const wakeup = await ownWakeup(id);
      if (!wakeup) {
        throw new Error(`[process_read] ${id} is not an active wakeup. Call wakeup_list to see active ids.`);
      }
      if (!wakeup.execId) {
        throw new Error(
          `[process_read] ${id} is a timer and has no log. Only a background process or watch has a log.`,
        );
      }
      const sb = session()?.sandbox;
      if (!sb?.pollJob) {
        throw new Error("[process_read] this sandbox backend cannot read background logs.");
      }
      const poll = await sb.pollJob(wakeup.execId, offset, { maxBytes: bytes });
      // A provider that ignores the bound returns more. Cut it here.
      const text = poll.output.slice(0, bytes);
      if (text.length < poll.output.length) {
        return { text, nextOffset: offset + Buffer.byteLength(text), eof: false };
      }
      return { text, nextOffset: poll.nextOffset, eof: poll.status !== "running" };
    },
  };
}
