/**
 * Workflow trigger management over the event-subscription system. A
 * "trigger" here is an `event_subscriptions` row with a
 * `{ kind: "workflow", workflowId }` target — the event dispatcher starts
 * a run for every matching event, delivering the event as
 * `trigger.data = { key, summary, refs, payload }`.
 *
 * Scoped deliberately to workflow targets: orchestrator/signal
 * subscriptions have their own management surface (`/api/event-subscriptions`).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions } from "../schema/index.js";
import { validateSubscription } from "../routes/events.js";
import { catalogForService } from "../events/ingest.js";
import {
  canAccessTriggerRow,
  ownedDefinitionRow,
  triggerAccessSets,
  type TriggerAccessSets,
  type WorkflowOwner,
} from "./service.js";

export interface WorkflowTriggerSummary {
  triggerId: string;
  workflowId: string;
  name: string;
  eventKeys: string[];
  filters: unknown[];
  enabled: boolean;
}

export interface EventTypeCatalog {
  service: string;
  entries: { key: string; description: string; filters: { field: string; description: string }[] }[];
}

export function listEventTypes(plugins: ValetPlugin[]): EventTypeCatalog[] {
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  return services.map((service) => ({
    service,
    entries: catalogForService(plugins, service).map((e) => ({
      key: e.key,
      description: e.description,
      filters: e.filters.map((f) => ({ field: f.field, description: f.description })),
    })),
  }));
}

function rowToTrigger(row: typeof eventSubscriptions.$inferSelect): WorkflowTriggerSummary | null {
  const target = row.target as { kind?: string; workflowId?: string };
  if (target?.kind !== "workflow" || typeof target.workflowId !== "string") return null;
  return {
    triggerId: row.id,
    workflowId: target.workflowId,
    name: row.name,
    eventKeys: row.eventKeys as string[],
    filters: (row.filters as unknown[]) ?? [],
    enabled: row.enabled,
  };
}

export async function createWorkflowTrigger(
  db: AppDb,
  plugins: ValetPlugin[],
  user: { id: string; orgId: string },
  input: { workflowId: string; name: string; eventKeys: string[]; filters?: unknown[] },
): Promise<{ ok: true; trigger: WorkflowTriggerSummary } | { ok: false; error: string }> {
  const target = { kind: "workflow" as const, workflowId: input.workflowId };
  const filters = input.filters ?? [];
  const error = validateSubscription(plugins, {
    name: input.name,
    eventKeys: input.eventKeys,
    filters,
    target,
  });
  if (error) return { ok: false, error };

  // Owner-scoped, not just org-scoped: checking only `orgId` let any org
  // member wire event-driven automation onto a workflow they don't own.
  // Unlike the schedule path, run ownership at fire time was already
  // correct here (`events/dispatcher.ts` bills the workflow definition's
  // own owner) — only this creation-time check needed the fix.
  const owned = await ownedDefinitionRow(db, { userId: user.id, orgId: user.orgId }, input.workflowId);
  if (!owned) return { ok: false, error: `workflow not found: ${input.workflowId}` };

  const now = Date.now();
  const inserted = await db
    .insert(eventSubscriptions)
    .values({
      id: randomUUID(),
      orgId: user.orgId,
      // Follow the workflow's own owner, the same rule a schedule on that
      // workflow follows (`schedule-service.ts`). These fields say which
      // workspace the trigger belongs to; `created_by` below says who armed
      // it. Only the team arm is taken — see the matching note in
      // `routes/events.ts` for why this one narrows where the schedules
      // writer does not.
      ownerType: owned.ownerType === "team" ? "team" : "user",
      ownerId: owned.ownerType === "team" ? owned.ownerId : user.id,
      name: input.name,
      eventKeys: input.eventKeys,
      filters,
      target,
      enabled: true,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const trigger = rowToTrigger(inserted[0]!);
  if (!trigger) return { ok: false, error: "trigger insert produced an unexpected row shape" };
  return { ok: true, trigger };
}

/** The row shape `canAccessTriggerRow` judges. The row's own owner now
 * follows the workflow's owner, so the owner arm admits teammates by
 * itself; the workflow-reach arm stays because rows written before that
 * change still carry their creator. One builder so the list filter and the
 * single-row loader can never disagree about that shape. */
function triggerAccessRow(
  row: typeof eventSubscriptions.$inferSelect,
  trigger: WorkflowTriggerSummary,
): { ownerType: string; ownerId: string; workflowId: string } {
  return { ownerType: row.ownerType, ownerId: row.ownerId, workflowId: trigger.workflowId };
}

/** Pass `sets` when the caller already holds this request's
 * `triggerAccessSets` (the aggregated triggers read builds them once for
 * both lists); omitted, the sets are fetched here. */
export async function listWorkflowTriggers(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId?: string,
  sets?: TriggerAccessSets,
): Promise<WorkflowTriggerSummary[]> {
  const conditions = [eq(eventSubscriptions.orgId, owner.orgId)];
  // `target` is JSONB; the workflow id lives at target->>'workflowId'.
  if (workflowId !== undefined) conditions.push(sql`${eventSubscriptions.target}->>'workflowId' = ${workflowId}`);
  const [rows, resolvedSets] = await Promise.all([
    db.select().from(eventSubscriptions).where(and(...conditions)),
    sets ?? triggerAccessSets(db, owner),
  ]);
  return rows
    .map((row) => {
      const trigger = rowToTrigger(row);
      if (!trigger) return null;
      return canAccessTriggerRow(owner, resolvedSets, triggerAccessRow(row, trigger)) ? trigger : null;
    })
    .filter((t): t is WorkflowTriggerSummary => t !== null);
}

/**
 * Loads one workflow-target trigger the caller may act on. Missing rows,
 * non-workflow subscriptions, and rows the caller cannot access all return
 * null — the route answers the same 404 for each, so a trigger id never
 * confirms another member's automation exists.
 */
async function accessibleTriggerRow(
  db: AppDb,
  owner: WorkflowOwner,
  triggerId: string,
): Promise<{ row: typeof eventSubscriptions.$inferSelect; trigger: WorkflowTriggerSummary } | null> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const trigger = rowToTrigger(row);
  if (!trigger) return null;
  if (!canAccessTriggerRow(owner, await triggerAccessSets(db, owner), triggerAccessRow(row, trigger))) return null;
  return { row, trigger };
}

export interface WorkflowTriggerPatch {
  name?: string;
  eventKeys?: string[];
  filters?: unknown[];
  enabled?: boolean;
}

export async function updateWorkflowTrigger(
  db: AppDb,
  plugins: ValetPlugin[],
  owner: WorkflowOwner,
  triggerId: string,
  patch: WorkflowTriggerPatch,
): Promise<
  | { ok: true; trigger: WorkflowTriggerSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const accessible = await accessibleTriggerRow(db, owner, triggerId);
  if (!accessible) return { ok: false, status: 404, error: "trigger not found" };
  const current = accessible.trigger;

  const name = patch.name ?? current.name;
  const eventKeys = patch.eventKeys ?? current.eventKeys;
  const filters = patch.filters ?? current.filters;
  const error = validateSubscription(plugins, {
    name,
    eventKeys,
    filters,
    target: { kind: "workflow", workflowId: current.workflowId },
  });
  if (error) return { ok: false, status: 400, error };

  const updated = await db
    .update(eventSubscriptions)
    .set({ name, eventKeys, filters, enabled: patch.enabled ?? current.enabled, updatedAt: Date.now() })
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)))
    .returning();
  const trigger = rowToTrigger(updated[0]!);
  if (!trigger) return { ok: false, status: 400, error: "trigger update produced an unexpected row shape" };
  return { ok: true, trigger };
}

export async function deleteWorkflowTrigger(
  db: AppDb,
  owner: WorkflowOwner,
  triggerId: string,
): Promise<"ok" | "not_found"> {
  // `accessibleTriggerRow` also refuses non-workflow subscriptions through
  // this seam — those belong to the orchestrator subscription surface.
  const accessible = await accessibleTriggerRow(db, owner, triggerId);
  if (!accessible) return "not_found";
  await db.delete(eventSubscriptions).where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)));
  return "ok";
}
