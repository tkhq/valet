/**
 * `wait` node executor (Phase 5 plan decision 11). Parks the run behind a
 * timer.
 *
 * Determinism rule: `wakeAt` is computed from the clock exactly once, at
 * first entry, and persisted in the intent checkpoint's `effects`. Every
 * subsequent drive (spurious wake, crash-resume, reclaim) reads `wakeAt`
 * back from `effects` rather than re-parsing `duration` against a fresh
 * clock read — otherwise a resumed run would wait the full duration again
 * instead of picking up where it left off.
 */

import { parseDurationMs } from '../dag/duration.js';
import type { WaitNode } from '../dag/nodes.js';
import type { NodeExecuteResult, NodeExecutorArgs } from './index.js';

export interface WaitResult {
  wakeAt: number;
}

export async function executeWait(args: NodeExecutorArgs<WaitNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, existingCheckpoint } = args;

  let wakeAt: number;
  if (existingCheckpoint !== undefined) {
    // Re-entry: read the previously-computed wakeAt back from effects.
    // Never re-derive it from `clock() + parseDurationMs(...)` here.
    const effWakeAt = existingCheckpoint.effects?.wakeAt;
    if (typeof effWakeAt !== 'number') {
      throw new Error(
        `wait node "${node.id}" resumed from an intent checkpoint with no numeric effects.wakeAt — contract violation`,
      );
    }
    wakeAt = effWakeAt;
  } else {
    const ms = parseDurationMs(node.duration);
    if (ms === null) {
      // Defensive: the validator (`dag/validate.ts`) rejects unparseable
      // `wait.duration` at definition time, so this should be unreachable
      // in practice.
      const error = `wait node "${node.id}" has an unparseable duration: ${JSON.stringify(node.duration)}`;
      await store.putIntent({
        runId: run.runId,
        nodeId: node.id,
        iteration,
        status: 'intent',
        attempt,
        createdAt: clock(),
      });
      await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
        runId: run.runId,
        nodeId: node.id,
        iteration,
        status: 'failed',
        error,
        attempt,
        createdAt: clock(),
      });
      return { status: 'failed', error };
    }
    wakeAt = clock() + ms;
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: { wakeAt },
    });
  }

  if (clock() >= wakeAt) {
    const result: WaitResult = { wakeAt };
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'completed',
      result,
      effects: { wakeAt },
      attempt,
      createdAt: clock(),
    });
    return { status: 'completed', result };
  }

  return { status: 'parked', waitingOn: [{ kind: 'timer', nodeId: node.id, wakeAt }] };
}
