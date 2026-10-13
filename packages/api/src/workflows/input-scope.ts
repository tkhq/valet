import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";

export interface InputSandboxScope {
  orgId: string;
  ownerType: string;
  ownerId: string;
}

/** Sandbox-controlled directory names must not probe another tenant's runs. */
export async function scopedInputRunStatus(db: AppDb, scope: InputSandboxScope, runId: string) {
  const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(and(eq(workflowRuns.id, runId), eq(workflowDefinitions.orgId, scope.orgId),
      eq(workflowRuns.ownerType, scope.ownerType), eq(workflowRuns.ownerId, scope.ownerId))).limit(1);
  return run?.status;
}
