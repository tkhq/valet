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
import { and, eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import { validateSubscription } from "../routes/events.js";
import { catalogForService } from "../events/ingest.js";

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

  const wfRows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, input.workflowId), eq(workflowDefinitions.orgId, user.orgId)))
    .limit(1);
  if (wfRows.length === 0) return { ok: false, error: `workflow not found: ${input.workflowId}` };

  const now = Date.now();
  const inserted = await db
    .insert(eventSubscriptions)
    .values({
      id: randomUUID(),
      orgId: user.orgId,
      ownerType: "user",
      ownerId: user.id,
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

export async function listWorkflowTriggers(
  db: AppDb,
  orgId: string,
  workflowId?: string,
): Promise<WorkflowTriggerSummary[]> {
  const rows = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.orgId, orgId));
  return rows
    .map(rowToTrigger)
    .filter((t): t is WorkflowTriggerSummary => t !== null)
    .filter((t) => workflowId === undefined || t.workflowId === workflowId);
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
  orgId: string,
  triggerId: string,
  patch: WorkflowTriggerPatch,
): Promise<
  | { ok: true; trigger: WorkflowTriggerSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  const current = row ? rowToTrigger(row) : null;
  if (!row || !current) return { ok: false, status: 404, error: "trigger not found" };

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
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, orgId)))
    .returning();
  const trigger = rowToTrigger(updated[0]!);
  if (!trigger) return { ok: false, status: 400, error: "trigger update produced an unexpected row shape" };
  return { ok: true, trigger };
}

export async function deleteWorkflowTrigger(
  db: AppDb,
  orgId: string,
  triggerId: string,
): Promise<"ok" | "not_found"> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  // Refuse to delete non-workflow subscriptions through this seam — those
  // belong to the orchestrator subscription surface.
  if (!row || rowToTrigger(row) === null) return "not_found";
  await db.delete(eventSubscriptions).where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, orgId)));
  return "ok";
}
