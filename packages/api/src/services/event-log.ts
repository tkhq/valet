/**
 * The Events page Log: a workspace's stored events and the organization's
 * recorded problems (the drop log) in one timeline, newest first, with one
 * status per row. Each source is read in keyset order and merged, so one
 * cursor pages the combined list. "Problems only" keeps failed events and
 * every drop.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EventLogItem, EventLogStatus } from "../wire/types.js";

/** A workspace-scoped Log reaches this far back for events, like the old feed. */
export const EVENT_LOG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

/** An event's status from this workspace's deliveries: a failure wins, then
 * work in flight, then a delivery. Only skipped deliveries read as skipped. */
const EVENT_STATUS = sql`CASE
  WHEN BOOL_OR(d.status IN ('failed','dead')) THEN 'failed'
  WHEN BOOL_OR(d.status = 'pending') THEN 'pending'
  WHEN BOOL_OR(d.status = 'delivered') THEN 'delivered'
  ELSE 'skipped' END`;

export interface EventLogQuery {
  orgId: string;
  /** Events reach the Log when this workspace's rules (or the org's) received them. */
  owner: Principal;
  admin: boolean;
  /** Only failed events and recorded problems. */
  problemsOnly?: boolean;
  q?: string;
  before?: { at: number; id: string };
  limit: number;
  now?: number;
  /** Whether the viewer may see a Slack channel (`slack:<id>`). A Slack event
   * from a channel they may not see stays out of their Log, as its page does. */
  channelVisible?: (channelKey: string) => Promise<boolean>;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** How many pages of events one Log read scans past hidden rows. */
const MAX_SCAN_BATCHES = 20;

export async function listEventLog(db: AppDb, query: EventLogQuery): Promise<{ items: EventLogItem[]; hasMore: boolean }> {
  const { orgId, owner, problemsOnly, limit } = query;
  const like = query.q ? `%${escapeLike(query.q)}%` : undefined;
  const take = limit + 1;

  const eventRows: EventLogItem[] = [];
  let moreEvents = false;
  {
    const where: SQL[] = [
      sql`e.org_id = ${orgId}`,
      sql`e.received_at >= ${(query.now ?? Date.now()) - EVENT_LOG_WINDOW_MS}`,
      // Only this workspace's deliveries (and the org's) count, so another
      // workspace's failure never marks this workspace's event failed.
      sql`s.org_id = ${orgId}`,
      sql`((s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}) OR s.owner_type = 'org')`,
    ];
    if (like) where.push(sql`(e.summary ILIKE ${like} ESCAPE '\\' OR e.event_key ILIKE ${like} ESCAPE '\\')`);
    const having = problemsOnly ? sql`HAVING ${EVENT_STATUS} = 'failed'` : sql``;
    // Rows a viewer may not see (a private Slack channel's) are dropped after
    // the read, so a page keeps reading until it holds `take` visible rows or
    // the events run out. The scan is bounded; past it the page says more.
    let before = query.before;
    for (let batch = 0; eventRows.length < take; batch++) {
      if (batch === MAX_SCAN_BATCHES) { moreEvents = true; break; }
      const scoped = before ? [...where, sql`(e.received_at, e.id) < (${before.at}, ${before.id})`] : where;
      const result = await db.execute(sql`
        SELECT e.id, e.service, e.event_key, e.summary, e.actor, e.received_at, ${EVENT_STATUS} AS status, COUNT(d.id)::int AS deliveries,
          CASE WHEN e.service = 'slack' THEN COALESCE(e.refs->>'channel', e.payload->'item'->>'channel', e.payload->>'channel_id',
            e.payload->'channel'->>'id', e.payload->>'channel') END AS slack_channel,
          MIN(d.last_error) FILTER (WHERE d.status = 'skipped') AS skipped_reason
        FROM events e JOIN event_deliveries d ON d.event_id = e.id JOIN event_subscriptions s ON s.id = d.subscription_id
        WHERE ${sql.join(scoped, sql` AND `)}
        GROUP BY e.id
        ${having}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT ${take}`) as { rows: Array<{
          id: string; service: string; event_key: string; summary: string | null; actor: unknown;
          received_at: string | number; status: EventLogStatus; deliveries: number; skipped_reason: string | null;
          slack_channel: string | null;
        }> };
      for (const row of result.rows) {
        if (row.slack_channel && query.channelVisible && !(await query.channelVisible(`slack:${row.slack_channel}`))) continue;
        const actor = row.actor && typeof row.actor === "object" ? row.actor as { login?: string; externalId?: string } : null;
        eventRows.push({
          kind: "event", id: row.id, at: Number(row.received_at), status: row.status,
          service: row.service, eventKey: row.event_key, summary: row.summary, actor: actor?.login ?? actor?.externalId ?? null,
          reason: null, detail: row.status === "skipped" ? row.skipped_reason : null, deliveryCount: Number(row.deliveries),
        });
      }
      const last = result.rows.at(-1);
      if (result.rows.length < take || !last) break;
      before = { at: Number(last.received_at), id: last.id };
    }
  }

  // Problems carry no owner, so the organization's are listed in every workspace.
  const problemRows: EventLogItem[] = [];
  {
    const where: SQL[] = [sql`org_id = ${orgId}`];
    if (!query.admin) where.push(sql`reason NOT IN (${sql.join(ADMIN_ONLY_REASONS.map((r) => sql`${r}`), sql`, `)})`);
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
  return { items: merged.slice(0, limit), hasMore: merged.length > limit || moreEvents };
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
