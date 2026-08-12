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
import { ownedDefinitionRow } from "./service.js";

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
  let scheduleOwner: { ownerType: "user" | "org"; ownerId: string } = {
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
    // Follow the workflow's own owner where this table's `owner_type`
    // enum (`user`/`org` only, no `team`) can represent it — a team-owned
    // workflow's schedule maps to the org rather than silently attributing
    // to whichever member happened to create it.
    scheduleOwner =
      owned.ownerType === "org"
        ? { ownerType: "org", ownerId: owned.ownerId }
        : owned.ownerType === "team"
          ? { ownerType: "org", ownerId: user.orgId }
          : { ownerType: "user", ownerId: owned.ownerId };
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

export async function listWorkflowSchedules(
  db: AppDb,
  orgId: string,
  workflowId?: string,
): Promise<WorkflowScheduleSummary[]> {
  const rows = await db.select().from(workflowSchedules).where(eq(workflowSchedules.orgId, orgId));
  return rows
    .map(rowToSummary)
    .filter((s) => workflowId === undefined || s.workflowId === workflowId);
}

export async function deleteWorkflowSchedule(
  db: AppDb,
  orgId: string,
  scheduleId: string,
  /** Scopes the delete to a schedule owned by THIS workflow when passed —
   * the HTTP management routes are mounted under `/:id/schedules`, and
   * without this a caller who owns any schedule in the org could delete
   * a different workflow's row through the wrong path. */
  workflowId?: string,
): Promise<"ok" | "not_found"> {
  const conditions = [eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, orgId)];
  if (workflowId !== undefined) conditions.push(eq(workflowSchedules.workflowId, workflowId));
  const rows = await db
    .select({ id: workflowSchedules.id })
    .from(workflowSchedules)
    .where(and(...conditions))
    .limit(1);
  if (rows.length === 0) return "not_found";
  // Delete under the same predicate the check used, not `id` alone. The
  // scoping is unreachable-by-luck otherwise: ids are UUID primary keys and
  // no code path reassigns `workflow_id` or `org_id`, so today the select
  // and the delete cannot resolve to different rows. Repeating the
  // conditions makes the constraint a property of the statement instead of
  // an invariant a later change could break without touching this file.
  await db.delete(workflowSchedules).where(and(...conditions));
  return "ok";
}
