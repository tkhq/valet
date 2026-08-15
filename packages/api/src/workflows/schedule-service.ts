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
import { workflowDefinitions, workflowSchedules } from "../schema/index.js";

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

  if (hasWorkflow) {
    const wfRows = await db
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, input.workflowId!), eq(workflowDefinitions.orgId, user.orgId)))
      .limit(1);
    if (wfRows.length === 0) return { ok: false, error: `workflow not found: ${input.workflowId}` };
  }

  const inserted = await db
    .insert(workflowSchedules)
    .values({
      id: randomUUID(),
      orgId: user.orgId,
      ownerType: "user",
      ownerId: user.id,
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
  orgId: string,
  scheduleId: string,
  patch: WorkflowSchedulePatch,
  now = Date.now(),
): Promise<
  | { ok: true; schedule: WorkflowScheduleSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const rows = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, orgId)))
    .limit(1);
  const row = rows[0];
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
    .where(eq(workflowSchedules.id, scheduleId))
    .returning();
  return { ok: true, schedule: rowToSummary(updated[0]!) };
}

export async function deleteWorkflowSchedule(
  db: AppDb,
  orgId: string,
  scheduleId: string,
): Promise<"ok" | "not_found"> {
  const rows = await db
    .select({ id: workflowSchedules.id })
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, orgId)))
    .limit(1);
  if (rows.length === 0) return "not_found";
  await db.delete(workflowSchedules).where(eq(workflowSchedules.id, scheduleId));
  return "ok";
}
