import { and, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDropLog, orgMembers, type EventDropLogRow } from "../schema/index.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MIN_TIMESTAMP = Number.MIN_SAFE_INTEGER;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadata(row: EventDropLogRow): Record<string, unknown> {
  return isRecord(row.eventMetadata) ? row.eventMetadata : {};
}

function timestampIsSafe(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= MIN_TIMESTAMP && value <= MAX_TIMESTAMP);
}

function transcriptIsShared(ctx: PluginActionContext): boolean {
  // A missing owner cannot prove that the transcript is private. A channel
  // origin also makes this turn member-visible, even in a user-owned session.
  return ctx.owner?.type !== "user" || ctx.origin !== undefined || ctx.sharedTranscript === true;
}

function publicMetadata(eventMetadata: Record<string, unknown>): Record<string, unknown> {
  const safeKeys = ["channel", "rawEventType", "rawSubtype"];
  return Object.fromEntries(safeKeys.flatMap((key) =>
    Object.hasOwn(eventMetadata, key) ? [[key, eventMetadata[key]]] : [],
  ));
}

function matchOutcome(reason: string): "excluded_by_filter" | null {
  return reason === "filter_excluded" ? "excluded_by_filter" : null;
}

/** Agent-facing counterpart of the Problems page. The drop log remains the
 * only store: it retains a small, redacted event identity for filter misses,
 * never the source payload. */
export function eventsActionPlugin(db: AppDb): ActionPlugin {
  const listProblems = action(
    Type.Object({
      event_key: Type.Optional(Type.String({ description: "Normalized event key, such as slack.message." })),
      channel: Type.Optional(Type.String({ description: "Slack channel ID when the received event has one." })),
      text: Type.Optional(Type.String({ description: "Exact redacted event text. Available only to organization admins in private, non-channel sessions." })),
      bot_id: Type.Optional(Type.String({ description: "Slack bot ID when the received event has one. Available only to organization admins in private, non-channel sessions." })),
      since: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP, description: "Earliest receipt timestamp as a safe epoch-millisecond integer." })),
      until: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP, description: "Latest receipt timestamp as a safe epoch-millisecond integer." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum records to return. Default ${DEFAULT_LIMIT}; maximum ${MAX_LIMIT}.` })),
    }),
  )({
    id: "events.list_problems",
    name: "List received event problems",
    description:
      "List received events that did not create a workflow run. Filter by normalized event key, Slack channel, receipt time, text, or bot ID. " +
      "Returns the received time, normalized key, raw event metadata, match outcome, and reason. Results are newest first.",
    riskLevel: "low",
    execute: async ({ event_key, channel, text, bot_id, since, until, limit }, ctx) => {
      const userId = ctx.actor?.id ?? ctx.userId;
      if (!userId || !ctx.orgId) return { success: false, error: "No authenticated organization member is available for this event query." };
      if (!timestampIsSafe(since) || !timestampIsSafe(until)) {
        return { success: false, error: "since and until must be safe epoch-millisecond integers." };
      }
      if (since !== undefined && until !== undefined && since > until) {
        return { success: false, error: "since must be earlier than or equal to until." };
      }
      const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
      if (!membership) return { success: false, error: "You are not a member of this organization." };
      const canReadAdminMetadata = membership.role === "admin" && !transcriptIsShared(ctx);
      if (!canReadAdminMetadata && (text !== undefined || bot_id !== undefined)) {
        return { success: false, error: "Text and bot ID filters require an organization admin in a private session that did not originate from a channel." };
      }
      const conditions = [eq(eventDropLog.orgId, ctx.orgId)];
      if (!canReadAdminMetadata) conditions.push(ne(eventDropLog.reason, "slack_interaction_unmatched"));
      if (event_key !== undefined) conditions.push(eq(eventDropLog.eventKey, event_key));
      if (since !== undefined) conditions.push(gte(eventDropLog.createdAt, since));
      if (until !== undefined) conditions.push(lte(eventDropLog.createdAt, until));
      // JSONB predicates must be part of the SQL query: filtering after LIMIT
      // could hide an older matching diagnostic behind newer unrelated rows.
      if (channel !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'channel' = ${channel}`);
      if (text !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'text' = ${text}`);
      if (bot_id !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'botId' = ${bot_id}`);
      const rows = await db.select().from(eventDropLog).where(and(...conditions))
        .orderBy(desc(eventDropLog.createdAt), desc(eventDropLog.id)).limit(Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      return {
        success: true,
        data: {
          problems: rows.map((row) => {
            const eventMetadata = metadata(row);
            const outputMetadata = canReadAdminMetadata ? eventMetadata : publicMetadata(eventMetadata);
            return {
              id: row.id,
              receivedAt: row.createdAt,
              normalizedEventKey: row.eventKey,
              matchOutcome: matchOutcome(row.reason),
              reason: row.reason,
              detail: row.detail,
              payloadMetadata: outputMetadata,
            };
          }),
          limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
        },
      };
    },
  });
  return { service: "events", description: "Inspect received event problems without changing event records.", actions: [listProblems] };
}
