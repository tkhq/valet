/**
 * Security cell compaction hook (M5, spec §Context Discipline "Compaction
 * hooks: checkpoint boundaries, not data loss"). Wired into the
 * `compactionHooks` of every cell-claimed child session the host builds
 * (`host.ts`, both the spawn-time and post-restart build paths).
 *
 * Alert, don't auto-repair (CLAUDE.md invariant rule): the hook stamps
 * `security_cells.compacted_at` (the cell rail's badge), and when the
 * cell's latest state doc is older than the checkpoint stride it emits the
 * `valet.security.compaction.stale` counter and logs a warning naming the
 * cell — a persona compacting on stale state is the moment work silently
 * evaporates, and it should page attention. NO status mutation, NO
 * re-dispatch, NO kill: cell status has one owner, the security routes.
 *
 * The engine try/catches each compaction hook, so a failure here never
 * blocks compaction. The hook is one indexed lookup plus one UPDATE — same
 * host-side directness as `orchestrator/compaction.ts`.
 */
import type { CompactionHook } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import {
  createSecurityEngagementService,
  STATE_DOC_STALE_MS,
} from "../services/security-engagements.js";
import { recordSecurityCompactionStale } from "../observability/security-metrics.js";

/** Builds the hook. `nowFn` is injectable for tests; the host passes none. */
export function securityCompactionHook(db: AppDb, nowFn: () => number = Date.now): CompactionHook {
  const service = createSecurityEngagementService({ db, now: nowFn });
  return async ({ sessionId, mode }) => {
    const stamp = await service.stampCellCompaction(sessionId);
    // No running cell claims this session (the claim settled while the
    // session stayed cached, or this is not a persona child) → no-op.
    if (!stamp) return;
    if (stamp.stale) {
      recordSecurityCompactionStale();
      console.warn(
        `security: cell ${stamp.cell.dir} (${stamp.cell.id}) compacted (${mode}) with its state doc ` +
          `${stamp.stateDocAgeMs}ms stale (stride ${STATE_DOC_STALE_MS}ms). ` +
          "Check the persona's checkpoint cadence; nothing auto-repairs this.",
      );
    }
  };
}
