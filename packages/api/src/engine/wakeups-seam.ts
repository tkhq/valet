import type { Lease, Sandbox, SessionStore, Wakeup, WakeupCreateInput, WakeupLimits, WakeupsSeam } from "@valet/engine";
import { newLeaseId, newWakeupId } from "@valet/engine/wakeups-ids";

/**
 * The slice of a live session the wakeups seam needs: the sandbox's job
 * API and the attachment's current sandbox id. Narrower than the full
 * engine `Session` class on purpose. `Session.attachment` is a
 * `SandboxAttachment` with private fields, so a test fixture cannot build
 * one without instantiating the real engine. Every real `Session` is
 * structurally assignable to this type, so `host.ts` passes `() =>
 * builtSession` straight through with no cast.
 */
export interface WakeupsSeamSession {
  sandbox: Sandbox;
  attachment: { sandboxId?: string };
}

export interface WakeupsSeamDeps {
  engineStore: SessionStore;
  limits: WakeupLimits;
  now?: () => number;
}

const BASH_BACKGROUND_UNAVAILABLE = "[bash_background] this sandbox backend cannot run background processes.";

const HOUR_MS = 3_600_000;

/**
 * Builds the `ToolContext.wakeups` seam for one session (Task 15,
 * spec 2026-10-08). The seam is the only path the engine's background-work
 * tools (`bash background`, `watch`, `wake_at`, `hold_sandbox`,
 * `process_read`, `wakeup_list`, `wakeup_cancel`) use to reach the store
 * and the sandbox's job API.
 */
export function buildWakeupsSeam(
  deps: WakeupsSeamDeps,
  sessionId: string,
  session: () => WakeupsSeamSession | undefined,
): WakeupsSeam {
  const { engineStore, limits } = deps;
  const now = deps.now ?? (() => Date.now());

  async function createProcessOrWatch(
    threadId: string,
    kind: "process" | "watch",
    command: string,
    reason: string,
    hours: number,
  ): Promise<{ wakeup: Wakeup; lease: Lease }> {
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
      return engineStore.getWakeup(id);
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
        const wakeup = await engineStore.getWakeup(id);
        if (!wakeup) return null;
        if ((wakeup.kind === "process" || wakeup.kind === "watch") && wakeup.execId) {
          // Best-effort: a dead sandbox or an already-exited job must not
          // block the cancel.
          await session()?.sandbox.cancelJob?.(wakeup.execId);
        }
        const transitioned = await engineStore.transitionWakeup(
          id,
          ["running", "pending"],
          "cancelled",
          { cause: "cancelled", endedAt: nowMs },
          nowMs,
        );
        if (!transitioned) return null;
        if (wakeup.leaseId) {
          await engineStore.releaseLease(wakeup.leaseId, "cancelled", nowMs);
        }
        return { kind: "wakeup" as const };
      }
      if (id.startsWith("ls_")) {
        const released = await engineStore.releaseLease(id, "cancelled", nowMs);
        return released ? { kind: "lease" as const } : null;
      }
      return null;
    },

    async readLog(id: string, offset: number, bytes: number) {
      const wakeup = await engineStore.getWakeup(id);
      const execId = wakeup?.execId;
      const sb = session()?.sandbox;
      if (!execId || !sb?.pollJob) {
        return { text: "", nextOffset: offset, eof: true };
      }
      const poll = await sb.pollJob(execId, offset);
      const text = poll.output.slice(0, bytes);
      const nextOffset = offset + Buffer.byteLength(text);
      const eof = poll.status !== "running" && text.length === poll.output.length;
      return { text, nextOffset, eof };
    },
  };
}
