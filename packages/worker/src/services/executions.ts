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
  resolveWorkflowConcurrencyLimits,
} from '../lib/db/executions.js';

export async function checkWorkflowConcurrency(
  database: AppDb,
  userId: string,
  limits: { perUser?: number; global?: number } = {},
): Promise<{ allowed: boolean; reason?: string; activeUser: number; activeGlobal: number }> {
  // An explicit `limits` argument still wins (callers that already resolved
  // the ceilings), otherwise fall back to the user's effective caps.
  let perUserLimit = limits.perUser;
  let globalLimit = limits.global;
  if (perUserLimit === undefined || globalLimit === undefined) {
    const resolved = await resolveWorkflowConcurrencyLimits(database, userId);
    perUserLimit ??= resolved.perUser;
    globalLimit ??= resolved.global;
  }

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
