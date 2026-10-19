import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventReceipts } from "../schema/index.js";
import type { EventReceiptWire, ReceiptStage, ReceiptSubscriptionDecision } from "../wire/types.js";

export const RECEIPT_RETENTION_DAYS = 7;
/** Retention runs at most this often per organization, not on every receipt,
 * so busy channel traffic does not repeat the same index scans. */
export const RECEIPT_CLEANUP_INTERVAL_MS = 60_000;
const lastCleanup = new Map<string, number>();
/** Whether this organization's receipts are due a retention pass, and claims it. */
export function receiptCleanupDue(orgId: string, now: number): boolean {
  if (now - (lastCleanup.get(orgId) ?? -Infinity) < RECEIPT_CLEANUP_INTERVAL_MS) return false;
  lastCleanup.set(orgId, now);
  return true;
}
/** Metadata keys a receipt keeps. `place` is the event's place key from its
 * natural subject (`github:acme/api`, `linear:team/ENG`), which ingest records
 * for every service but Slack; a Slack receipt keeps `channelId` and
 * `workspaceId`. Receipts written before ingest recorded `place` carry none. */
const metadataKeys = new Set(["place", "channelId", "workspaceId", "actorId", "botId", "appId", "rawType", "rawSubtype", "messageTs", "threadTs", "retryNum", "retryReason", "botIdentityAvailable", "botUserIdentityAvailable", "payloadBytes", "configuredTriggerCount"]);
const outcomes = new Set(["matched", "filter_excluded", "authorization_denied", "disabled", "key_mismatch"]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, max = 256): string => typeof value === "string" ? value.slice(0, max) : "";
export function sanitizeReceiptMetadata(value: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(record(value)).filter(([key, v]) => metadataKeys.has(key) && (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 256) : v])) as Record<string, string | number | boolean>;
}
export function sanitizeReceiptStages(value: unknown): ReceiptStage[] {
  return (Array.isArray(value) ? value : []).slice(-20).map(record).map(v => ({ stage: bounded(v.stage, 64), outcome: bounded(v.outcome, 64), detail: bounded(v.detail, 512), at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0 }));
}
export function sanitizeReceiptSubscriptions(value: unknown): ReceiptSubscriptionDecision[] {
  return (Array.isArray(value) ? value : []).slice(0, 50).map(record).filter(v => outcomes.has(String(v.outcome))).map(v => ({
    id: bounded(v.id), ...(typeof v.name === "string" ? { name: bounded(v.name) } : {}), ownerType: bounded(v.ownerType, 16), ownerId: bounded(v.ownerId), target: bounded(v.target, 64),
    ...(typeof v.targetId === "string" ? { targetId: bounded(v.targetId) } : {}),
    outcome: v.outcome as ReceiptSubscriptionDecision["outcome"],
    ...(Array.isArray(v.failedFilters) ? { failedFilters: v.failedFilters.slice(0, 20).map(record).map(f => ({ field: bounded(f.field, 128), op: bounded(f.op, 32) })) } : {}),
  }));
}
export function receiptWire(row: typeof eventReceipts.$inferSelect): EventReceiptWire {
  return { id: row.id, service: bounded(row.service), externalId: row.externalId === null ? null : bounded(row.externalId), metadata: sanitizeReceiptMetadata(row.metadata), stages: sanitizeReceiptStages(row.stages), subscriptions: sanitizeReceiptSubscriptions(row.subscriptions), eventKey: row.eventKey === null ? null : bounded(row.eventKey), eventId: row.eventId === null ? null : bounded(row.eventId), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export async function createEventReceipt(db: AppDb, input: { orgId: string; service: string; externalId?: string; metadata?: Record<string, unknown> }): Promise<string | undefined> {
  try {
    const id = randomUUID(), now = Date.now();
    await db.insert(eventReceipts).values({ id, orgId: input.orgId, service: bounded(input.service), externalId: input.externalId === undefined ? null : bounded(input.externalId), metadata: sanitizeReceiptMetadata(input.metadata), stages: [], subscriptions: [], createdAt: now, updatedAt: now });
    // Each pass removes everything past the age window and the row cap, so
    // the table stays bounded however fast receipts arrive between passes.
    if (receiptCleanupDue(input.orgId, now)) try {
      await db.execute(sql`DELETE FROM event_receipts WHERE org_id = ${input.orgId} AND (created_at < ${now - RECEIPT_RETENTION_DAYS * 86_400_000}
        OR id IN (SELECT id FROM event_receipts WHERE org_id = ${input.orgId} ORDER BY created_at DESC, id DESC OFFSET 10000))`);
    } catch { console.warn("[event-receipts] cleanup unavailable"); }
    return id;
  } catch { console.warn("[event-receipts] write unavailable"); return undefined; }
}
export async function appendReceiptStage(db: AppDb, receiptId: string | undefined, stage: { stage: string; outcome: string; detail: string }, patch?: { eventKey?: string; eventId?: string; subscriptions?: ReceiptSubscriptionDecision[]; metadata?: Record<string, string> }): Promise<void> {
  if (!receiptId) return;
  try {
    const now = Date.now(), stages = JSON.stringify(sanitizeReceiptStages([{ ...stage, at: now }]));
    await db.update(eventReceipts).set({
      // One row update serializes concurrent appenders without losing stages.
      stages: sql`(SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(${eventReceipts.stages} || ${stages}::jsonb) WITH ORDINALITY AS entries(item, ord) WHERE ord > jsonb_array_length(${eventReceipts.stages} || ${stages}::jsonb) - 20)`,
      updatedAt: now,
      ...(patch?.eventKey !== undefined ? { eventKey: bounded(patch.eventKey) } : {}),
      ...(patch?.eventId !== undefined ? { eventId: bounded(patch.eventId) } : {}),
      ...(patch?.subscriptions !== undefined ? { subscriptions: sanitizeReceiptSubscriptions(patch.subscriptions) } : {}),
      // Merged into the stored metadata, through the same allow-list as a new receipt.
      ...(patch?.metadata !== undefined ? { metadata: sql`(CASE WHEN jsonb_typeof(${eventReceipts.metadata}) = 'object' THEN ${eventReceipts.metadata} ELSE '{}'::jsonb END) || ${JSON.stringify(sanitizeReceiptMetadata(patch.metadata))}::jsonb` } : {}),
    }).where(eq(eventReceipts.id, receiptId));
  } catch { console.warn("[event-receipts] write unavailable"); }
}

/**
 * The receipt stage for one assistant delivery's destination (spec
 * 2026-10-16: delivery threads, Part E step 1). It holds ids and the
 * reason only, never the thread title or payload text.
 */
export function destinationReceiptStage(
  ids: { subscriptionId: string; deliveryId: string },
  outcome: { kind: "key"; key: string; reason: string } | { kind: "target"; sessionId: string; threadId: string; reason: string }
    | { kind: "skip"; reason: string; outcome?: string } | { kind: "pin_unavailable"; sessionId: string; threadId: string },
): { stage: string; outcome: string; detail: string } {
  const prefix = `Subscription ${ids.subscriptionId}, delivery ${ids.deliveryId}:`;
  switch (outcome.kind) {
    case "key": return { stage: "destination", outcome: outcome.reason, detail: `${prefix} thread key ${outcome.key}.` };
    case "target": return { stage: "destination", outcome: outcome.reason, detail: `${prefix} session ${outcome.sessionId}, thread ${outcome.threadId}.` };
    case "skip": return { stage: "destination", outcome: outcome.outcome ?? "claim_skip", detail: `${prefix} skipped, ${outcome.reason}.` };
    case "pin_unavailable": return { stage: "destination", outcome: "pin_unavailable", detail: `${prefix} pinned session ${outcome.sessionId}, thread ${outcome.threadId} cannot receive deliveries.` };
  }
}

/**
 * Append a stage to the receipt of a stored event, when that event has one.
 * With `onceFor`, a stage of the same name whose detail already contains
 * that text is not appended again, so a retried delivery records once.
 * Returns what happened, so a caller can count only a first record.
 */
export async function appendReceiptStageForEvent(
  db: AppDb, orgId: string, eventId: string,
  stage: { stage: string; outcome: string; detail: string },
  onceFor?: string,
): Promise<"appended" | "exists" | "no_receipt"> {
  try {
    const [row] = await db.select({ id: eventReceipts.id, stages: eventReceipts.stages }).from(eventReceipts)
      .where(and(eq(eventReceipts.orgId, orgId), eq(eventReceipts.eventId, eventId))).limit(1);
    if (!row) return "no_receipt";
    if (onceFor !== undefined && sanitizeReceiptStages(row.stages).some((s) => s.stage === stage.stage && s.detail.includes(onceFor))) return "exists";
    await appendReceiptStage(db, row.id, stage);
    return "appended";
  } catch {
    console.warn("[event-receipts] write unavailable");
    return "no_receipt";
  }
}

/** The text that names one delivery in its `destination` stage, for `onceFor`. */
export function destinationStageMarker(deliveryId: string): string {
  return `delivery ${deliveryId}:`;
}
