/**
 * The Events page Log: stored events and recorded problems (the drop log) in
 * one timeline, newest first, with one status per row. Each source is read in
 * keyset order and merged, so one cursor pages the combined list.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EventLogItem, EventLogStatus } from "../wire/types.js";

/** A workspace-scoped Log reaches this far back for events, like the old feed. */
export const EVENT_LOG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const EVENT_LOG_STATUSES: readonly EventLogStatus[] = ["delivered", "pending", "failed", "filtered", "no_match", "rejected"];

/** Drop reasons that mean the event never reached a subscription on purpose. */
const REJECTED_REASONS = [
  "slack_classifier_rejected", "slack_interaction_unmatched", "bad_signature", "foreign_workspace", "unknown_org",
  "unlinked_sender", "unauthorized", "verify_failed", "malformed_callback", "duplicate", "unsupported_kind", "slack_retry",
];
/** Reasons only org admins see: they identify Slack form activity. */
const ADMIN_ONLY_REASONS = ["slack_interaction_unmatched", "slack_classifier_rejected"];

export function dropStatus(reason: string): EventLogStatus {
  if (reason === "filter_excluded") return "filtered";
  if (reason === "no_subscription_match") return "no_match";
  if (REJECTED_REASONS.includes(reason)) return "rejected";
  return "failed";
}

function dropStatusSql(status: EventLogStatus): SQL | null {
  if (status === "filtered") return sql`reason = 'filter_excluded'`;
  if (status === "no_match") return sql`reason = 'no_subscription_match'`;
  if (status === "rejected") return sql`reason IN (${sql.join(REJECTED_REASONS.map((r) => sql`${r}`), sql`, `)})`;
  if (status === "failed") {
    return sql`reason NOT IN (${sql.join([...REJECTED_REASONS, "filter_excluded", "no_subscription_match"].map((r) => sql`${r}`), sql`, `)})`;
  }
  return null;
}

/** An event's status from its deliveries: a failure wins, then work in flight. */
const EVENT_STATUS = sql`CASE
  WHEN BOOL_OR(d.status IN ('failed','dead')) THEN 'failed'
  WHEN BOOL_OR(d.status = 'pending') THEN 'pending'
  WHEN BOOL_OR(d.status = 'delivered') THEN 'delivered'
  WHEN COUNT(d.id) > 0 THEN 'delivered'
  ELSE 'no_match' END`;

export interface EventLogQuery {
  orgId: string;
  /** Null lists the whole org; a workspace sees events its rules (or the org's) received. */
  owner: Principal | null;
  admin: boolean;
  status?: EventLogStatus;
  service?: string;
  q?: string;
  before?: { at: number; id: string };
  limit: number;
  now?: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function listEventLog(db: AppDb, query: EventLogQuery): Promise<{ items: EventLogItem[]; hasMore: boolean }> {
  const { orgId, owner, status, service, limit } = query;
  const like = query.q ? `%${escapeLike(query.q)}%` : undefined;
  const take = limit + 1;

  // Events: problem-only statuses never come from a stored event.
  const wantEvents = !status || status === "delivered" || status === "pending" || status === "failed";
  const eventRows: EventLogItem[] = [];
  if (wantEvents) {
    const where: SQL[] = [sql`e.org_id = ${orgId}`];
    if (owner) {
      where.push(sql`e.received_at >= ${(query.now ?? Date.now()) - EVENT_LOG_WINDOW_MS}`);
      where.push(sql`EXISTS (SELECT 1 FROM event_deliveries od JOIN event_subscriptions s ON s.id = od.subscription_id
        WHERE od.event_id = e.id AND s.org_id = ${orgId}
          AND ((s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}) OR s.owner_type = 'org'))`);
    }
    if (service) where.push(sql`e.service = ${service}`);
    if (like) where.push(sql`(e.summary ILIKE ${like} ESCAPE '\\' OR e.event_key ILIKE ${like} ESCAPE '\\')`);
    if (query.before) where.push(sql`(e.received_at, e.id) < (${query.before.at}, ${query.before.id})`);
    const having = status ? sql`HAVING ${EVENT_STATUS} = ${status}` : sql``;
    const result = await db.execute(sql`
      SELECT e.id, e.service, e.event_key, e.summary, e.actor, e.received_at, ${EVENT_STATUS} AS status, COUNT(d.id)::int AS deliveries
      FROM events e LEFT JOIN event_deliveries d ON d.event_id = e.id
      WHERE ${sql.join(where, sql` AND `)}
      GROUP BY e.id
      ${having}
      ORDER BY e.received_at DESC, e.id DESC
      LIMIT ${take}`) as { rows: Array<{
        id: string; service: string; event_key: string; summary: string | null; actor: unknown;
        received_at: string | number; status: EventLogStatus; deliveries: number;
      }> };
    for (const row of result.rows) {
      const actor = row.actor && typeof row.actor === "object" ? row.actor as { login?: string; externalId?: string } : null;
      eventRows.push({
        kind: "event", id: row.id, at: Number(row.received_at), status: row.status,
        service: row.service, eventKey: row.event_key, summary: row.summary, actor: actor?.login ?? actor?.externalId ?? null,
        reason: null, detail: null, deliveryCount: Number(row.deliveries),
      });
    }
  }

  // Problems: the drop log is org-wide, so it shows in every scope.
  const wantProblems = !status || (status !== "delivered" && status !== "pending");
  const problemRows: EventLogItem[] = [];
  if (wantProblems) {
    const where: SQL[] = [sql`org_id = ${orgId}`];
    if (!query.admin) where.push(sql`reason NOT IN (${sql.join(ADMIN_ONLY_REASONS.map((r) => sql`${r}`), sql`, `)})`);
    const statusSql = status ? dropStatusSql(status) : null;
    if (statusSql) where.push(statusSql);
    if (service) where.push(sql`event_key LIKE ${`${escapeLike(service)}.%`} ESCAPE '\\'`);
    if (like) where.push(sql`(reason ILIKE ${like} ESCAPE '\\' OR detail ILIKE ${like} ESCAPE '\\')`);
    if (query.before) where.push(sql`(created_at, id) < (${query.before.at}, ${query.before.id})`);
    const result = await db.execute(sql`
      SELECT id, reason, detail, event_key, created_at FROM event_drop_log
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY created_at DESC, id DESC
      LIMIT ${take}`) as { rows: Array<{ id: string; reason: string; detail: string | null; event_key: string | null; created_at: string | number }> };
    for (const row of result.rows) {
      problemRows.push({
        kind: "problem", id: row.id, at: Number(row.created_at), status: dropStatus(row.reason),
        service: row.event_key?.split(".")[0] ?? null, eventKey: row.event_key, summary: null, actor: null,
        reason: row.reason, detail: row.detail, deliveryCount: 0,
      });
    }
  }

  const merged = [...eventRows, ...problemRows].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { items: merged.slice(0, limit), hasMore: merged.length > limit };
}

/** When anything last reached ingest: a stored event or a visible problem. */
export async function lastEventLogActivity(db: AppDb, orgId: string, admin: boolean): Promise<number | null> {
  const hidden = admin ? sql`` : sql`AND reason NOT IN (${sql.join(ADMIN_ONLY_REASONS.map((r) => sql`${r}`), sql`, `)})`;
  const result = await db.execute(sql`
    SELECT GREATEST(
      (SELECT MAX(received_at) FROM events WHERE org_id = ${orgId}),
      (SELECT MAX(created_at) FROM event_drop_log WHERE org_id = ${orgId} ${hidden})
    ) AS at`) as { rows: Array<{ at: string | number | null }> };
  const at = result.rows[0]?.at;
  return at === null || at === undefined ? null : Number(at);
}
