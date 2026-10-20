/**
 * The columns of a stored event that the Presence and Activity reads select.
 * A provider payload can be tens of kilobytes, and a request that reads many
 * events spends its time moving and parsing payloads it never reads. These
 * reads select the event without its payload, or with only the payload keys
 * that `slackEventChannel` reads.
 */
import { sql } from "drizzle-orm";
import { events } from "../schema/index.js";

/** A stored event without its payload. */
export type EventHead = Omit<typeof events.$inferSelect, "payload">;

/** A stored event with only the payload keys that name its Slack channel (`eventChannelPayload`). */
export type EventHeadWithChannel = EventHead & { payload: unknown };

/** Every column of `events` but `payload`, for `db.select(...)`. */
export const eventHeadColumns = {
  id: events.id,
  orgId: events.orgId,
  service: events.service,
  eventKey: events.eventKey,
  dedupeKey: events.dedupeKey,
  actor: events.actor,
  refs: events.refs,
  summary: events.summary,
  occurredAt: events.occurredAt,
  receivedAt: events.receivedAt,
  subjects: events.subjects,
};

/**
 * SQL: the payload keys `slackEventChannel` falls back to (`channel`, or its
 * `id` when it is an object, `channel_id`, and `item.channel`), for a Slack
 * event only. Any other event reads as a null payload, which that function
 * does not read.
 */
export const eventChannelPayload = sql<unknown>`CASE WHEN ${events.service} = 'slack' THEN jsonb_build_object(
  'channel', CASE WHEN jsonb_typeof(${events.payload} -> 'channel') = 'object'
    THEN jsonb_build_object('id', ${events.payload} -> 'channel' -> 'id') ELSE ${events.payload} -> 'channel' END,
  'channel_id', ${events.payload} -> 'channel_id',
  'item', jsonb_build_object('channel', ${events.payload} -> 'item' -> 'channel')) END`;

/** `eventHeadColumns` with the trimmed payload of `eventChannelPayload`. */
export const eventChannelColumns = { ...eventHeadColumns, payload: eventChannelPayload };
