/**
 * Autonomy nudge sweep for security engagements (spec §Autonomy). A security
 * runner must be autonomous: it drives the loop until `sec_close` and never
 * stops to ask the user for permission. The ONE legitimate pause is the
 * `sec_start` approval gate (and any tool approval). If the runner ends a turn
 * while the engagement still has work and nothing is in flight, it stopped
 * with work to do — this sweep re-drives it with a NUDGE.
 *
 * DESIGN — a stateless sweep, NOT an event/awaitResult watcher. A gate-blocked
 * OR actively-working submission is UNSETTLED, so "the runner has no unsettled
 * submission" cleanly means idle. Polling handles every idle-with-work gap
 * regardless of what settled the runner: a settle whose signal never landed, a
 * turn that ended early, a crash-window resume. The self-advance loop
 * (`child.settled` → runner turn) stays the primary driver; this is the safety
 * net under it.
 *
 * Alert, don't auto-repair (CLAUDE.md): this is an EXPLICIT, OBSERVABLE, CAPPED
 * driver, not a silent invariant repair. A stall cap bounds it: after N
 * no-progress nudges the sweep stops nudging, posts ONE message asking the user
 * to step in, and emits `valet.security.runner.stalled`. A genuinely stuck
 * runner pages a human instead of looping forever.
 */
import { and, count, eq, or } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import {
  agentSessions,
  securityCells,
  securityEngagements,
  securityFindings,
  type SecurityCellRow,
  type SecurityEngagementRow,
} from "../schema/index.js";
import { recordSecurityRunnerStalled } from "../observability/security-metrics.js";

const DEFAULT_SWEEP_INTERVAL_MS = 20_000;
const DEFAULT_MAX_STALLS = 3;

/** The re-drive prompt. Names the exact next step so the runner resumes the
 * loop rather than re-explaining its state. */
export const NUDGE_TEXT =
  "The security engagement is not complete and no cell is running. Do not wait for the user. " +
  "Call sec_status now and continue the loop: dispatch the next pending or yielded cell, " +
  "complete a settled one, or call sec_close when every cell is done.";

/** The one message the sweep posts when the stall cap trips, then it goes
 * quiet until the engagement makes progress. */
function stallText(nudges: number): string {
  return (
    `The engagement has not progressed after ${nudges} nudges. It needs your input: ` +
    "review the cell rail and tell me how to proceed, or ask me to continue."
  );
}

/** The submit seam. Defaults to `submitSessionPrompt`; tests inject a spy so
 * they assert the call and its text without a real engine turn. */
export type RunnerSubmit = (
  row: typeof agentSessions.$inferSelect,
  text: string,
) => Promise<unknown>;

/** Per-engagement stall budget. In-memory only: a restart resets the budget,
 * which mirrors ChildWatcher's in-process attempt reset — acceptable, because
 * a nudge that a restart re-issues costs one extra turn, not correctness. */
interface StallState {
  /** Progress signature at the last would-nudge decision. */
  signature: string;
  /** No-progress nudges accumulated against `signature`. */
  stalls: number;
  /** True once the stall message was posted for `signature` — post it once. */
  alerted: boolean;
}

export interface SecurityRunnerDriverDeps {
  db: AppDb;
  engineStore: {
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
  };
  /** The submit seam. The real binding is `submitSessionPrompt({db, engineHost},
   * row, text)`; the driver stores it so tests can inject a spy. */
  submit: RunnerSubmit;
  /** Override for tests. */
  now?: () => number;
  /** `<= 0` disables the sweep (start() no-ops), matching idle-hibernation. */
  sweepIntervalMs?: number;
  /** No-progress nudges before the sweep alerts instead of nudging. */
  maxStalls?: number;
}

export class SecurityRunnerDriver {
  private timer: SweepTimer | null = null;
  /** Keyed by engagement id; evicted when an engagement leaves
   * planning/running so the map cannot grow unbounded. */
  private readonly stalls = new Map<string, StallState>();
  private readonly now: () => number;
  private readonly maxStalls: number;

  constructor(private readonly deps: SecurityRunnerDriverDeps) {
    this.now = deps.now ?? Date.now;
    this.maxStalls = deps.maxStalls ?? DEFAULT_MAX_STALLS;
  }

  async sweep(): Promise<void> {
    const engagements = await this.deps.db
      .select()
      .from(securityEngagements)
      .where(
        or(eq(securityEngagements.status, "planning"), eq(securityEngagements.status, "running")),
      );
    const live = new Set(engagements.map((e) => e.id));
    // Evict budget for engagements no longer planning/running (completed or
    // failed, or deleted). Bounds the map to the active engagement set.
    for (const id of this.stalls.keys()) {
      if (!live.has(id)) this.stalls.delete(id);
    }
    for (const engagement of engagements) {
      try {
        await this.driveEngagement(engagement);
      } catch (err) {
        // Best-effort: one engagement's failure never aborts the sweep.
        console.error(`SecurityRunnerDriver: drive failed for engagement ${engagement.id}:`, err);
      }
    }
  }

  private async driveEngagement(engagement: SecurityEngagementRow): Promise<void> {
    // 1. The runner session must exist and be live (not archived/deleted).
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, engagement.sessionId))
      .limit(1);
    const runnerRow = rows[0];
    if (!runnerRow || runnerRow.status === "archived" || runnerRow.status === "deleted") {
      return;
    }

    const cells = await this.deps.db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, engagement.id));

    // 2. A persona child is in flight → skip. The child.settled signal drives
    // the runner; nudging now would race that self-advance.
    if (cells.some((c) => c.status === "running")) return;

    // 3. A gated OR actively-working submission is UNSETTLED. A non-empty list
    // means the runner is either working or blocked on the sec_start approval
    // gate — either way, DO NOT nudge. This is what keeps the sweep silent
    // during an approval: the gate holds an unsettled submission.
    const unsettled = await this.deps.engineStore.listUnsettledSubmissions(engagement.sessionId);
    if (unsettled.length > 0) return;

    // 4. Idle with the engagement not complete → the runner stopped with work
    // to do. Apply the stall cap, then nudge.
    await this.nudgeOrAlert(engagement, cells, runnerRow);
  }

  private async nudgeOrAlert(
    engagement: SecurityEngagementRow,
    cells: SecurityCellRow[],
    runnerRow: typeof agentSessions.$inferSelect,
  ): Promise<void> {
    const signature = await this.progressSignature(engagement, cells);
    const prior = this.stalls.get(engagement.id);

    if (!prior || prior.signature !== signature) {
      // Progress (or first sight): reset the budget, then nudge once.
      this.stalls.set(engagement.id, { signature, stalls: 1, alerted: false });
      await this.deps.submit(runnerRow, NUDGE_TEXT);
      return;
    }

    if (prior.stalls >= this.maxStalls) {
      // Cap reached: no more nudges for this signature. Alert ONCE, then stay
      // quiet until the signature changes (user intervention resets the
      // counter above and resumes nudging).
      if (!prior.alerted) {
        prior.alerted = true;
        recordSecurityRunnerStalled();
        await this.deps.submit(runnerRow, stallText(prior.stalls));
      }
      return;
    }

    // Same signature, under the cap: count this no-progress nudge and re-drive.
    prior.stalls += 1;
    await this.deps.submit(runnerRow, NUDGE_TEXT);
  }

  /** A stable signature of engagement progress: status, every cell's status by
   * ordinal, and the finding count. It changes exactly when the engagement
   * advances, so an unchanged signature across nudges means the runner is
   * stuck. */
  private async progressSignature(
    engagement: SecurityEngagementRow,
    cells: SecurityCellRow[],
  ): Promise<string> {
    const [{ n: findings }] = await this.deps.db
      .select({ n: count() })
      .from(securityFindings)
      .where(eq(securityFindings.engagementId, engagement.id));
    const cellStates = [...cells]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => [c.ordinal, c.status] as const);
    return JSON.stringify([engagement.status, cellStates, Number(findings ?? 0)]);
  }

  /** Start the sweep interval. `<= 0` interval disables it (no-op). */
  start(): void {
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (this.timer || intervalMs <= 0) return;
    this.timer = startSweepTimer("SecurityRunnerDriver", intervalMs, () => this.sweep());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
