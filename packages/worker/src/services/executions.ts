/**
 * Shared execution helpers for the trigger paths. Status persistence
 * lives in workflows/execution-status.ts and trace persistence lives
 * in workflows/trace-writer.ts — this module only owns the
 * pre-dispatch concurrency check.
 */

import type { AppDb } from '../lib/drizzle.js';
import {
  countActiveExecutions,
  countActiveExecutionsGlobal,
  resolveUserExecutionCap,
} from '../lib/db/executions.js';
import { GLOBAL_EXECUTION_CONCURRENCY_CAP } from '../lib/db/constants.js';

export async function checkWorkflowConcurrency(
  database: AppDb,
  userId: string,
  limits: { perUser?: number; global?: number } = {},
): Promise<{ allowed: boolean; reason?: string; activeUser: number; activeGlobal: number }> {
  // An explicit `limits.perUser` still wins, and skips the DB read — callers
  // dispatching in a loop resolve the cap once and pass it in. The global cap
  // is a constant, so supplying only `perUser` costs no read at all.
  const perUserLimit = limits.perUser ?? await resolveUserExecutionCap(database, userId);
  const globalLimit = limits.global ?? GLOBAL_EXECUTION_CONCURRENCY_CAP;

  const activeUser = await countActiveExecutions(database, userId);
  const activeGlobal = await countActiveExecutionsGlobal(database);

  if (activeUser >= perUserLimit) {
    return {
      allowed: false,
      reason: `per_user_limit_exceeded:${perUserLimit}`,
      activeUser,
      activeGlobal,
    };
  }

  if (activeGlobal >= globalLimit) {
    return {
      allowed: false,
      reason: `global_limit_exceeded:${globalLimit}`,
      activeUser,
      activeGlobal,
    };
  }

  return { allowed: true, activeUser, activeGlobal };
}
