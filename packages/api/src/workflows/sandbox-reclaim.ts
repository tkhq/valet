/**
 * Settled-run sandbox reclaim. Every workflow `session` node provisions a
 * sandbox for its `wf:{runId}:{nodeId}[:{iteration}]` session, and until
 * this module nothing ever destroyed it: workflow sessions have no
 * `agent_sessions` row, so both the hibernation reaper and the child
 * retention sweep are blind to them. A 10-minute scheduled workflow with an
 * 11-way foreach fan-out leaks ~66 sandboxes per hour — observed as 419
 * orphaned Sandbox CRs saturating a cluster (2026-08-22 incident).
 *
 * Two entry points, one reclaim:
 *   - `reclaimRun` runs from the `onRunSettled` hook — the immediate path.
 *   - `sweep` runs on an interval over settled `workflow_runs` rows whose
 *     `sandbox_reclaimed_at` is NULL — it catches runs settled while the
 *     api was down, on-settle reclaims that failed, and every run settled
 *     before this module existed.
 *
 * A run is stamped `sandbox_reclaimed_at` only when every one of its
 * sessions reclaimed cleanly; a partial reclaim leaves the stamp NULL so
 * the sweep retries. Race rules mirror `ChildWatcher.sweepRetention`:
 * unsettled submissions always win, re-checked immediately before the
 * destroy. Session data (threads, transcript, cost rows) is untouched —
 * only the sandbox and its tokens go.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import { recordSandboxDestroyed, type AttachmentState } from "@valet/engine";
import type { WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { workflowRuns } from "../schema/index.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";
import { workflowSessionWorkspace } from "./engine-deps.js";

const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60_000;
/** A run settled less than this long ago is left to the on-settle path. */
const SWEEP_SETTLE_GRACE_MS = 5 * 60_000;
/** Rows per sweep pass — bounds the first pass over a pre-existing backlog. */
const SWEEP_BATCH_LIMIT = 100;

/** The slice of a cached `Session` the reclaim touches. Structural (not
 * `Pick`s of the real types) so tests hand in plain fakes without casts. */
interface ReclaimLiveSession {
  attachment: {
    readonly state: AttachmentState;
    destroy(reason?: string): Promise<void>;
  };
}

export interface WorkflowSandboxReclaimerDeps {
  db: AppDb;
  engineHost: {
    liveSession(sessionId: string): ReclaimLiveSession | null;
    destroySandbox(sandboxId: string): Promise<void>;
    deriveSandboxId(sessionKey: string): string | null;
    evictCache(sessionId: string): void;
  };
  engineStore: {
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
  };
  store: Pick<WorkflowStore, "getCheckpoints">;
  /** Override for tests. */
  sweepIntervalMs?: number;
}

export class WorkflowSandboxReclaimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WorkflowSandboxReclaimerDeps) {}

  /**
   * Destroy the sandboxes of every session a run's checkpoints name, then
   * stamp `sandbox_reclaimed_at`. Contained: `onRunSettled` fires on an
   * already-settled run, so a throw would abandon a drive lease nothing
   * reclaims — every failure degrades to a log line and a sweep retry.
   */
  async reclaimRun(runId: string, now = Date.now()): Promise<void> {
    try {
      const sessionIds = await this.runSessionIds(runId);
      let allReclaimed = true;
      for (const sessionId of sessionIds) {
        const ok = await this.reclaimSession(sessionId).catch((err) => {
          console.error(`WorkflowSandboxReclaimer: reclaim failed for session ${sessionId}:`, err);
          return false;
        });
        if (!ok) allReclaimed = false;
      }
      if (!allReclaimed) return; // stamp stays NULL; the sweep retries
      await this.deps.db
        .update(workflowRuns)
        .set({ sandboxReclaimedAt: now })
        .where(
          and(
            eq(workflowRuns.id, runId),
            eq(workflowRuns.status, "settled"),
            isNull(workflowRuns.sandboxReclaimedAt),
          ),
        );
    } catch (err) {
      console.error(`WorkflowSandboxReclaimer: reclaim failed for run ${runId}:`, err);
    }
  }

  /**
   * Settled runs the on-settle path missed. The grace window keeps the
   * sweep from racing a reclaim already in flight for a just-settled run.
   */
  async sweep(now = Date.now()): Promise<void> {
    const rows = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, "settled"),
          isNull(workflowRuns.sandboxReclaimedAt),
          lte(workflowRuns.updatedAt, now - SWEEP_SETTLE_GRACE_MS),
        ),
      )
      .orderBy(workflowRuns.updatedAt)
      .limit(SWEEP_BATCH_LIMIT);
    for (const row of rows) {
      await this.reclaimRun(row.id, now);
    }
  }

  /**
   * Every session the run's checkpoints name, deduped across attempts and
   * iterations. Only `wf:{thisRunId}:` ids qualify — an `orchestrator`
   * node's checkpoint carries the ASSISTANT session id in the same effects
   * slot, and that session's sandbox belongs to the assistant, not the run.
   */
  private async runSessionIds(runId: string): Promise<string[]> {
    const checkpoints = await this.deps.store.getCheckpoints(runId);
    const ids = new Set<string>();
    for (const cp of checkpoints) {
      const sessionId = cp.effects?.sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith(`wf:${runId}:`)) {
        ids.add(sessionId);
      }
    }
    return [...ids];
  }

  /** True when the session's sandbox is gone (or was never destroyable). */
  private async reclaimSession(sessionId: string): Promise<boolean> {
    // The run is settled, but an in-flight submission (a node aborted
    // mid-turn, a repair prompt) must never lose its sandbox mid-turn.
    const unsettled = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
    if (unsettled.length > 0) return false;

    const live = this.deps.engineHost.liveSession(sessionId);
    if (live) {
      // Re-check immediately before the destroy (the idle sweep's race
      // rule): a submission admitted since the check above wins.
      const recheck = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
      if (recheck.length > 0) return false;
      await live.attachment.destroy("run_settled");
      this.deps.engineHost.evictCache(sessionId);
      console.log(`WorkflowSandboxReclaimer: reclaimed cached sandbox for session ${sessionId}`);
    } else {
      // Uncached (an api restart evicted it, or the sweep found an old
      // run): recompute the deterministic handle from the session's
      // workspace path — the same key `create` named the sandbox from. A
      // name matching nothing is a tolerated 404. Backends with
      // provider-assigned ids (docker/local) have nothing to destroy from
      // here; say so and stop re-sweeping the run.
      const handle = this.deps.engineHost.deriveSandboxId(workflowSessionWorkspace(sessionId));
      if (handle) {
        await this.deps.engineHost.destroySandbox(handle);
        recordSandboxDestroyed("run_settled");
        console.log(`WorkflowSandboxReclaimer: reclaimed sandbox ${handle} for session ${sessionId}`);
      } else {
        console.warn(
          `WorkflowSandboxReclaimer: session ${sessionId} is not cached and has no derivable sandbox handle; stamping reclaimed without a destroy`,
        );
      }
    }
    await revokeSandboxTokens(this.deps.db, sessionId);
    return true;
  }

  /** Start the sweep interval. Unref'd — never holds the process open. */
  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.sweep().catch((err) => console.error("WorkflowSandboxReclaimer: sweep failed:", err));
    }, intervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
