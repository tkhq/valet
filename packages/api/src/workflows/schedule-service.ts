/**
 * Workflow cron schedules — CRUD + next-fire computation. The scheduler
 * loop (`scheduler.ts`) polls `workflow_schedules` for due rows and starts
 * runs; this module owns validation and the cron math so both the loop and
 * the agent tools share one implementation.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import type { AppDb } from "../lib/drizzle.js";
import { workflowSchedules } from "../schema/index.js";
import {
  canAccessTriggerRow,
  canAccessTriggerRowInScope,
  ownedDefinitionRow,
  scopedTriggerAccess,
  triggerAccessSets,
  type TriggerAccessSets,
  type WorkflowOwner,
  type WorkflowOwnerRef,
} from "./service.js";

export interface WorkflowScheduleSummary {
  scheduleId: string;
  targetKind: "workflow" | "orchestrator";
  workflowId?: string;
  prompt?: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  input?: unknown;
  lastFiredAt: number | null;
  nextFireAt: number;
}

/**
 * Validates a 5-field cron expression + IANA timezone and returns the next
 * fire time strictly after `from`. Returns an error string instead of
 * throwing so tool callers surface it as lint-style feedback.
 */
export function nextFireAt(
  cron: string,
  timezone: string,
  from: number,
): { ok: true; at: number } | { ok: false; error: string } {
  if (cron.trim().split(/\s+/).length !== 5) {
    return {
      ok: false,
      error: `cron must be a 5-field expression (minute hour day-of-month month day-of-week), got ${JSON.stringify(cron)}`,
    };
  }
  try {
    // Timezone validity check — cron-parser silently falls back on some
    // invalid tz strings; Intl throws, which is the behavior we want.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { ok: false, error: `unknown timezone ${JSON.stringify(timezone)} — use an IANA name like "America/Denver"` };
  }
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: timezone });
    return { ok: true, at: interval.next().getTime() };
  } catch (err) {
    return { ok: false, error: `invalid cron ${JSON.stringify(cron)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function rowToSummary(row: typeof workflowSchedules.$inferSelect): WorkflowScheduleSummary {
  return {
    scheduleId: row.id,
    targetKind: row.targetKind,
    workflowId: row.workflowId ?? undefined,
    prompt: row.prompt ?? undefined,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    input: row.input ?? undefined,
    lastFiredAt: row.lastFiredAt,
    nextFireAt: row.nextFireAt,
  };
}

export async function createWorkflowSchedule(
  db: AppDb,
  user: { id: string; orgId: string },
  input: {
    /** Exactly one of `workflowId` (start a run) or `prompt` (prompt the
     * orchestrator — V1's `schedule_target=orchestrator`). */
    workflowId?: string;
    prompt?: string;
    name: string;
    cron: string;
    timezone?: string;
    input?: unknown;
  },
  now = Date.now(),
): Promise<{ ok: true; schedule: WorkflowScheduleSummary } | { ok: false; error: string }> {
  const timezone = input.timezone ?? "UTC";
  const next = nextFireAt(input.cron, timezone, now);
  if (!next.ok) return next;

  const hasWorkflow = typeof input.workflowId === "string" && input.workflowId.length > 0;
  const hasPrompt = typeof input.prompt === "string" && input.prompt.trim().length > 0;
  if (hasWorkflow === hasPrompt) {
    return {
      ok: false,
      error: "provide exactly one of workflow_id (start a workflow run) or prompt (prompt the orchestrator)",
    };
  }

  // The schedule row's own `ownerType`/`ownerId` (below) is unrelated to run
  // billing for a workflow target — `scheduler.ts`'s `fire()` bills
  // `def.ownerType`/`ownerId` (the workflow's real owner) directly, by
  // design, never these fields. They matter only for an orchestrator-prompt
  // target, which `deliverToOrchestrator` reads.
  let scheduleOwner: { ownerType: "user" | "team" | "org"; ownerId: string } = {
    ownerType: "user",
    ownerId: user.id,
  };

  if (hasWorkflow) {
    // Owner-scoped, not just org-scoped: checking only `orgId` let any org
    // member wire a schedule onto a workflow they don't own — and because
    // `scheduler.ts` used to bill the SCHEDULE's owner (this function's
    // `user`) rather than the workflow's, that org member became the
    // owner of runs against someone else's resource. See `scheduler.ts`'s
    // `fire()` for the matching run-ownership fix.
    const owned = await ownedDefinitionRow(db, { userId: user.id, orgId: user.orgId }, input.workflowId!);
    if (!owned) return { ok: false, error: `workflow not found: ${input.workflowId}` };
    // Follow the workflow's own owner exactly. This used to widen a team
    // workflow's schedule to the ORG, because `owner_type` could not hold a
    // team — which handed a team's scheduled prompt to the org assistant,
    // a strictly larger audience than the team that owns the workflow. The
    // column now holds a team, so the schedule follows its workflow.
    scheduleOwner = { ownerType: owned.ownerType, ownerId: owned.ownerId };
  }

  const inserted = await db
    .insert(workflowSchedules)
    .values({
      id: randomUUID(),
      orgId: user.orgId,
      ownerType: scheduleOwner.ownerType,
      ownerId: scheduleOwner.ownerId,
      targetKind: hasWorkflow ? "workflow" : "orchestrator",
      workflowId: hasWorkflow ? input.workflowId! : null,
      prompt: hasPrompt ? input.prompt! : null,
      name: input.name,
      cron: input.cron,
      timezone,
      input: input.input ?? null,
      enabled: true,
      nextFireAt: next.at,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { ok: true, schedule: rowToSummary(inserted[0]!) };
}

/** Pass `sets` when the caller already holds this request's
 * `triggerAccessSets` (the aggregated triggers read builds them once for
 * both lists); omitted, the sets are fetched here. */
export async function listWorkflowSchedules(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId?: string,
  sets?: TriggerAccessSets,
  scope?: WorkflowOwnerRef,
): Promise<WorkflowScheduleSummary[]> {
  const conditions = [eq(workflowSchedules.orgId, owner.orgId)];
  if (workflowId !== undefined) conditions.push(eq(workflowSchedules.workflowId, workflowId));
  const rows = await db.select().from(workflowSchedules).where(and(...conditions));
  // A scoped list shows ONE workspace: a row owned by the scope, or targeting
  // a workflow it owns. Unlike the caller's-reach filter, a personal row does
  // not ride along into a team scope.
  if (scope) {
    const access = await scopedTriggerAccess(db, scope);
    return rows.filter((row) => canAccessTriggerRowInScope(access, row)).map(rowToSummary);
  }
  const resolvedSets = sets ?? (await triggerAccessSets(db, owner));
  return rows.filter((row) => canAccessTriggerRow(owner, resolvedSets, row)).map(rowToSummary);
}

/**
 * Loads one schedule the caller may act on. Returns null for a missing row
 * AND for a row the caller cannot access — the two must answer identically
 * (the same 404) so a schedule id never confirms another member's
 * automation exists. Shared by update/delete here and `fireNow` in
 * `scheduler.ts`.
 */
export async function accessibleScheduleRow(
  db: AppDb,
  owner: WorkflowOwner,
  scheduleId: string,
  workflowId?: string,
): Promise<typeof workflowSchedules.$inferSelect | null> {
  const conditions = [eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, owner.orgId)];
  if (workflowId !== undefined) conditions.push(eq(workflowSchedules.workflowId, workflowId));
  const rows = await db
    .select()
    .from(workflowSchedules)
    .where(and(...conditions))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return canAccessTriggerRow(owner, await triggerAccessSets(db, owner), row) ? row : null;
}

export interface WorkflowSchedulePatch {
  name?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  input?: unknown;
}

/**
 * Partial update. Target kind is immutable — delete and recreate to switch.
 * `nextFireAt` is recomputed when cron/timezone change or when the schedule
 * transitions disabled → enabled (so a stale slot does not fire at once).
 */
export async function updateWorkflowSchedule(
  db: AppDb,
  owner: WorkflowOwner,
  scheduleId: string,
  patch: WorkflowSchedulePatch,
  now = Date.now(),
): Promise<
  | { ok: true; schedule: WorkflowScheduleSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const row = await accessibleScheduleRow(db, owner, scheduleId);
  if (!row) return { ok: false, status: 404, error: "schedule not found" };

  if (patch.prompt !== undefined && row.targetKind !== "orchestrator") {
    return {
      ok: false,
      status: 400,
      error: "prompt only applies to orchestrator-target schedules. Delete this schedule and create an orchestrator one to switch.",
    };
  }
  if (patch.input !== undefined && row.targetKind !== "workflow") {
    return {
      ok: false,
      status: 400,
      error: "input only applies to workflow-target schedules. Delete this schedule and create a workflow one to switch.",
    };
  }
  if (patch.prompt !== undefined && patch.prompt.trim() === "") {
    return { ok: false, status: 400, error: "prompt must not be empty. Provide the text to send to the orchestrator." };
  }

  const cron = patch.cron ?? row.cron;
  const timezone = patch.timezone ?? row.timezone;
  const cronOrTzChanged = cron !== row.cron || timezone !== row.timezone;
  const reEnabled = patch.enabled === true && !row.enabled;

  let nextAt = row.nextFireAt;
  if (cronOrTzChanged || reEnabled) {
    const next = nextFireAt(cron, timezone, now);
    if (!next.ok) return { ok: false, status: 400, error: next.error };
    nextAt = next.at;
  }

  const updated = await db
    .update(workflowSchedules)
    .set({
      name: patch.name ?? row.name,
      cron,
      timezone,
      enabled: patch.enabled ?? row.enabled,
      prompt: patch.prompt ?? row.prompt,
      input: patch.input !== undefined ? patch.input : row.input,
      nextFireAt: nextAt,
      updatedAt: now,
    })
    .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, owner.orgId)))
    .returning();
  return { ok: true, schedule: rowToSummary(updated[0]!) };
}

export async function deleteWorkflowSchedule(
  db: AppDb,
  owner: WorkflowOwner,
  scheduleId: string,
  /** Scopes the delete to a schedule owned by THIS workflow when passed —
   * the HTTP management routes are mounted under `/:id/schedules`, and
   * without this a caller who owns any schedule in the org could delete
   * a different workflow's row through the wrong path. */
  workflowId?: string,
): Promise<"ok" | "not_found"> {
  const row = await accessibleScheduleRow(db, owner, scheduleId, workflowId);
  if (!row) return "not_found";
  // Delete under the same predicate the check used, not `id` alone. The
  // scoping is unreachable-by-luck otherwise: ids are UUID primary keys and
  // no code path reassigns `workflow_id` or `org_id`, so today the select
  // and the delete cannot resolve to different rows. Repeating the
  // conditions makes the constraint a property of the statement instead of
  // an invariant a later change could break without touching this file.
  const conditions = [eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, owner.orgId)];
  if (workflowId !== undefined) conditions.push(eq(workflowSchedules.workflowId, workflowId));
  await db.delete(workflowSchedules).where(and(...conditions));
  return "ok";
}
