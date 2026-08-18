import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { calendarFetch } from "./api.js";

// ─── Shared schema ────────────────────────────────────────────────────────────

const eventDateTimeSchema = Type.Object({
  dateTime: Type.Optional(
    Type.String({
      description:
        'RFC3339 timestamp with timezone offset, e.g. "2026-04-15T14:00:00-08:00". Use this for timed events.',
    }),
  ),
  date: Type.Optional(
    Type.String({
      description: 'ISO date "YYYY-MM-DD" for all-day events. Use instead of dateTime.',
    }),
  ),
  timeZone: Type.Optional(
    Type.String({
      description: 'IANA timezone like "America/Los_Angeles". Optional when dateTime has an offset.',
    }),
  ),
});

type EventDateTime = Static<typeof eventDateTimeSchema>;

/**
 * Legacy Zod schema used `.refine((v) => v.dateTime || v.date, ...)` on
 * eventDateTimeSchema. TypeBox has no equivalent, so the constraint is
 * re-checked here, verbatim in spirit, at every call site that used the
 * refined schema (create_event's start/end, update_event's optional
 * start/end when provided).
 */
function checkEventDateTime(v: EventDateTime): string | null {
  if (v.dateTime || v.date) return null;
  return "Provide either dateTime (timed event) or date (all-day event).";
}

/**
 * Curried action builder. The first call binds T from the parameters
 * schema; the second call types `execute`'s args via Static<T>. Splitting
 * the inference into two phases sidesteps TS's contextual-inference depth
 * limit, which otherwise gives up on `args: any` once the file gets long.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

/**
 * Google API error bodies are structured JSON like
 * {"error":{"code":400,"message":"...","errors":[...]}}. Pull out the
 * human-readable message; fall back to the raw body when it isn't JSON.
 */
function extractApiErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (typeof err === "object" && err !== null && "message" in err) {
        const message = (err as { message: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
}

// ─── Credential Helper ─────────────────────────────────────────────────────────

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? "";
}

// ─── Actions ────────────────────────────────────────────────────────────────

const listEvents = action(
  Type.Object({
    calendarId: Type.Optional(
      Type.String({
        default: "primary",
        description: 'Calendar ID. Defaults to "primary" (the user\'s main calendar).',
      }),
    ),
    q: Type.Optional(
      Type.String({
        description: "Free-text search across summary, description, location, and attendees.",
      }),
    ),
    timeMin: Type.Optional(
      Type.String({
        description:
          'Lower bound (inclusive) as RFC3339 timestamp, e.g. "2026-04-10T00:00:00-08:00". Defaults to now.',
      }),
    ),
    timeMax: Type.Optional(
      Type.String({ description: "Upper bound (exclusive) as RFC3339 timestamp." }),
    ),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 2500,
        default: 25,
        description: "Maximum number of events to return (1-2500). Defaults to 25.",
      }),
    ),
    singleEvents: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "If true (default), expands recurring events into individual instances. Set false to receive recurring events as a single record.",
      }),
    ),
  }),
)({
  id: "calendar.list_events",
  name: "List Events",
  description:
    "Lists or searches Google Calendar events. Defaults to the user's primary calendar starting now. Use timeMin/timeMax (RFC3339 timestamps) to bound the window, q for free-text search, and maxResults to cap the count. Returns event IDs needed for updateEvent and deleteEvent.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    try {
      const calendarId = p.calendarId ?? "primary";
      const maxResults = p.maxResults ?? 25;
      const singleEvents = p.singleEvents ?? true;
      const timeMin = p.timeMin ?? new Date().toISOString();
      const qs = new URLSearchParams({
        maxResults: String(maxResults),
        singleEvents: String(singleEvents),
      });
      if (timeMin) qs.set("timeMin", timeMin);
      if (p.timeMax) qs.set("timeMax", p.timeMax);
      if (p.q) qs.set("q", p.q);
      if (singleEvents) qs.set("orderBy", "startTime");

      const res = await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
        token,
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404)
          return { success: false, error: `Calendar not found (ID: ${calendarId}).` };
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar.events scope was granted.",
          };
        return { success: false, error: `Failed to list events: ${res.status} ${body}` };
      }
      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          status?: string;
          summary?: string;
          description?: string;
          location?: string;
          start?: { dateTime?: string; date?: string; timeZone?: string };
          end?: { dateTime?: string; date?: string; timeZone?: string };
          attendees?: Array<{
            email?: string;
            responseStatus?: string;
            optional?: boolean;
          }>;
          organizer?: { email?: string };
          htmlLink?: string;
          recurringEventId?: string;
        }>;
        nextPageToken?: string;
      };
      const events = (data.items ?? []).map((event) => ({
        id: event.id,
        status: event.status,
        summary: event.summary ?? null,
        description: event.description ?? null,
        location: event.location ?? null,
        start: event.start ?? null,
        end: event.end ?? null,
        attendees:
          event.attendees?.map((a) => ({
            email: a.email,
            responseStatus: a.responseStatus,
            optional: a.optional ?? false,
          })) ?? [],
        organizer: event.organizer?.email ?? null,
        htmlLink: event.htmlLink ?? null,
        recurringEventId: event.recurringEventId ?? null,
      }));
      return {
        success: true,
        data: { events, count: events.length, nextPageToken: data.nextPageToken ?? null },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const createEvent = action(
  Type.Object({
    calendarId: Type.Optional(
      Type.String({ default: "primary", description: 'Calendar ID. Defaults to "primary".' }),
    ),
    summary: Type.String({ description: "Event title." }),
    description: Type.Optional(Type.String({ description: "Event description / notes." })),
    location: Type.Optional(Type.String({ description: "Physical address or location string." })),
    start: Type.Object(eventDateTimeSchema.properties, {
      description: "Event start. Provide dateTime or date.",
    }),
    end: Type.Object(eventDateTimeSchema.properties, {
      description: "Event end. Provide dateTime or date. For all-day events, end.date is exclusive.",
    }),
    attendees: Type.Optional(
      Type.Array(
        Type.Object({
          email: Type.String({ description: "Attendee email address." }),
          optional: Type.Optional(Type.Boolean({ description: "Mark attendee as optional." })),
        }),
        { description: "List of attendees to invite." },
      ),
    ),
    sendUpdates: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")], {
        default: "none",
        description:
          'Whether to send email invitations: "all" sends to everyone, "externalOnly" only to non-domain attendees, "none" sends nothing (default).',
      }),
    ),
    conferenceData: Type.Optional(
      Type.Boolean({
        default: false,
        description: "If true, attaches an automatically generated Google Meet link to the event.",
      }),
    ),
  }),
)({
  id: "calendar.create_event",
  name: "Create Event",
  description:
    "Creates a new event on a Google Calendar. Supports timed events (start/end with dateTime) and all-day events (start/end with date). Set sendUpdates to email invitations to attendees.",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    const startError = checkEventDateTime(p.start);
    if (startError) return { success: false, error: startError };
    const endError = checkEventDateTime(p.end);
    if (endError) return { success: false, error: endError };
    try {
      const calendarId = p.calendarId ?? "primary";
      const sendUpdates = p.sendUpdates ?? "none";
      const qs = new URLSearchParams({ sendUpdates });
      if (p.conferenceData) qs.set("conferenceDataVersion", "1");

      const requestBody: Record<string, unknown> = {
        summary: p.summary,
        start: p.start,
        end: p.end,
      };
      if (p.description !== undefined) requestBody.description = p.description;
      if (p.location !== undefined) requestBody.location = p.location;
      if (p.attendees !== undefined) requestBody.attendees = p.attendees;
      if (p.conferenceData) {
        requestBody.conferenceData = {
          createRequest: {
            requestId: `valet-${crypto.randomUUID()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }

      const res = await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
        token,
        { method: "POST", body: JSON.stringify(requestBody) },
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404)
          return { success: false, error: `Calendar not found (ID: ${calendarId}).` };
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar.events scope was granted.",
          };
        if (res.status === 400)
          return {
            success: false,
            error: `Calendar rejected the event: ${body}. Check that start/end formats are valid RFC3339.`,
          };
        return { success: false, error: `Failed to create event: ${res.status} ${body}` };
      }
      const event = (await res.json()) as {
        id?: string;
        summary?: string;
        start?: unknown;
        end?: unknown;
        htmlLink?: string;
        hangoutLink?: string;
        attendees?: unknown[];
      };
      return {
        success: true,
        data: {
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          htmlLink: event.htmlLink,
          hangoutLink: event.hangoutLink ?? null,
          attendees: event.attendees?.length ?? 0,
          message: `Event "${event.summary}" created.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const updateEvent = action(
  Type.Object({
    calendarId: Type.Optional(
      Type.String({ default: "primary", description: 'Calendar ID. Defaults to "primary".' }),
    ),
    eventId: Type.String({ description: "The event ID to update (from list_events)." }),
    summary: Type.Optional(Type.String({ description: "New event title." })),
    description: Type.Optional(Type.String({ description: "New event description." })),
    location: Type.Optional(Type.String({ description: "New location." })),
    start: Type.Optional(
      Type.Object(eventDateTimeSchema.properties, { description: "New start time." }),
    ),
    end: Type.Optional(
      Type.Object(eventDateTimeSchema.properties, { description: "New end time." }),
    ),
    attendees: Type.Optional(
      Type.Array(
        Type.Object({
          email: Type.String(),
          optional: Type.Optional(Type.Boolean()),
        }),
        { description: "Replaces the entire attendee list. To add one, fetch the event first." },
      ),
    ),
    sendUpdates: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")], {
        default: "none",
        description: "Whether to email attendees about the change.",
      }),
    ),
  }),
)({
  id: "calendar.update_event",
  name: "Update Event",
  description:
    "Updates an existing Google Calendar event with PATCH semantics — only the fields you provide are changed; everything else stays the same. Common uses: reschedule (set start+end), retitle (set summary), add/remove attendees (set attendees array which fully replaces).",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    if (p.start !== undefined) {
      const startError = checkEventDateTime(p.start);
      if (startError) return { success: false, error: startError };
    }
    if (p.end !== undefined) {
      const endError = checkEventDateTime(p.end);
      if (endError) return { success: false, error: endError };
    }
    try {
      const calendarId = p.calendarId ?? "primary";
      const sendUpdates = p.sendUpdates ?? "none";
      const qs = new URLSearchParams({ sendUpdates });

      const requestBody: Record<string, unknown> = {};
      if (p.summary !== undefined) requestBody.summary = p.summary;
      if (p.description !== undefined) requestBody.description = p.description;
      if (p.location !== undefined) requestBody.location = p.location;
      if (p.start !== undefined) requestBody.start = p.start;
      if (p.end !== undefined) requestBody.end = p.end;
      if (p.attendees !== undefined) requestBody.attendees = p.attendees;

      if (Object.keys(requestBody).length === 0) {
        return {
          success: false,
          error:
            "No fields provided to update. Pass at least one of summary, description, location, start, end, or attendees.",
        };
      }

      const res = await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(p.eventId)}?${qs}`,
        token,
        { method: "PATCH", body: JSON.stringify(requestBody) },
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404)
          return {
            success: false,
            error: `Event not found: ${p.eventId} on calendar ${calendarId}.`,
          };
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar.events scope was granted.",
          };
        if (res.status === 400)
          return {
            success: false,
            error: `Calendar rejected the update: ${body}.`,
          };
        return { success: false, error: `Failed to update event: ${res.status} ${body}` };
      }
      const event = (await res.json()) as {
        id?: string;
        summary?: string;
        start?: unknown;
        end?: unknown;
        htmlLink?: string;
        updated?: string;
      };
      return {
        success: true,
        data: {
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          htmlLink: event.htmlLink,
          updated: event.updated,
          message: `Event ${event.id} updated.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteEvent = action(
  Type.Object({
    calendarId: Type.Optional(
      Type.String({ default: "primary", description: 'Calendar ID. Defaults to "primary".' }),
    ),
    eventId: Type.String({ description: "The event ID to delete (from list_events)." }),
    sendUpdates: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")], {
        default: "none",
        description: "Whether to email cancellation notices to attendees.",
      }),
    ),
  }),
)({
  id: "calendar.delete_event",
  name: "Delete Event",
  description:
    "Deletes an event from a Google Calendar. This is permanent — the event is removed, not trashed. Use sendUpdates to email cancellations to attendees.",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    try {
      const calendarId = p.calendarId ?? "primary";
      const sendUpdates = p.sendUpdates ?? "none";
      const qs = new URLSearchParams({ sendUpdates });

      const res = await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(p.eventId)}?${qs}`,
        token,
        { method: "DELETE" },
      );
      if (!res.ok) {
        if (res.status === 404)
          return { success: false, error: `Event not found: ${p.eventId}.` };
        if (res.status === 410)
          return { success: false, error: `Event ${p.eventId} was already deleted.` };
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar.events scope was granted.",
          };
        const body = await res.text();
        return { success: false, error: `Failed to delete event: ${res.status} ${body}` };
      }
      return {
        success: true,
        data: {
          eventId: p.eventId,
          calendarId,
          message: `Event ${p.eventId} deleted from calendar ${calendarId}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const quickAdd = action(
  Type.Object({
    calendarId: Type.Optional(
      Type.String({ default: "primary", description: 'Calendar ID. Defaults to "primary".' }),
    ),
    text: Type.String({
      description:
        "Natural-language description of the event. Google parses the title and time from this string.",
    }),
    sendUpdates: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")], {
        default: "none",
        description: "Whether to email invitations (rarely useful for quick add).",
      }),
    ),
  }),
)({
  id: "calendar.quick_add",
  name: "Quick Add Event",
  description:
    'Creates a calendar event from a natural-language string using Google Calendar\'s quick-add parser. Examples: "Lunch with Sarah tomorrow at 12pm", "Dentist appointment next Tuesday 3-4pm", "Team standup every weekday 9am". Faster than create_event when you don\'t need attendees, descriptions, or precise control over fields.',
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    try {
      const calendarId = p.calendarId ?? "primary";
      const sendUpdates = p.sendUpdates ?? "none";
      const qs = new URLSearchParams({ text: p.text, sendUpdates });

      const res = await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?${qs}`,
        token,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404)
          return { success: false, error: `Calendar not found (ID: ${calendarId}).` };
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar.events scope was granted.",
          };
        if (res.status === 400)
          return {
            success: false,
            error: `Calendar could not parse "${p.text}" as an event. Try a clearer time format.`,
          };
        return { success: false, error: `Failed to quick-add event: ${res.status} ${body}` };
      }
      const event = (await res.json()) as {
        id?: string;
        summary?: string;
        start?: unknown;
        end?: unknown;
        htmlLink?: string;
      };
      return {
        success: true,
        data: {
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          htmlLink: event.htmlLink,
          message: `Event "${event.summary}" created from "${p.text}".`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const queryFreeBusy = action(
  Type.Object({
    items: Type.Array(
      Type.String({
        description: "Calendar ID to query. For a co-worker, this is their email address.",
      }),
      {
        minItems: 1,
        description:
          "Calendars to query, by ID. A person's primary calendar ID is their email address. No subscription to their calendar is needed — only free/busy visibility.",
      },
    ),
    timeMin: Type.String({
      description: 'Window start (inclusive) as RFC3339 timestamp, e.g. "2026-04-20T08:00:00-07:00".',
    }),
    timeMax: Type.String({
      description: "Window end (exclusive) as RFC3339 timestamp.",
    }),
    timeZone: Type.Optional(
      Type.String({
        description: 'IANA timezone like "America/Los_Angeles" for the returned intervals. Defaults to UTC.',
      }),
    ),
  }),
)({
  id: "calendar.query_free_busy",
  name: "Query Free/Busy",
  description:
    "Returns busy intervals for one or more calendars in a time window — including co-workers' calendars you are not subscribed to (query by their email address). Use this to find a common free slot before create_event. Returns busy blocks only, never event details. A calendar the user cannot see reports a per-calendar error instead of failing the query.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: "Missing access token" };
    if (p.items.length > 50) {
      return {
        success: false,
        error: `Too many calendars: ${p.items.length}. Query at most 50 calendars per request.`,
      };
    }
    try {
      const requestBody: Record<string, unknown> = {
        timeMin: p.timeMin,
        timeMax: p.timeMax,
        items: p.items.map((id) => ({ id })),
      };
      if (p.timeZone !== undefined) requestBody.timeZone = p.timeZone;

      const res = await calendarFetch("/freeBusy", token, {
        method: "POST",
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 403)
          return {
            success: false,
            error: "Permission denied. Confirm the calendar scope was granted.",
          };
        if (res.status === 400)
          return {
            success: false,
            error: `Calendar rejected the free/busy query: ${extractApiErrorMessage(body)}. Check that timeMin/timeMax are valid RFC3339 timestamps.`,
          };
        return { success: false, error: `Failed to query free/busy: ${res.status} ${body}` };
      }
      const data = (await res.json()) as {
        calendars?: Record<
          string,
          {
            busy?: Array<{ start?: string; end?: string }>;
            errors?: Array<{ domain?: string; reason?: string }>;
          }
        >;
      };
      const calendars: Record<
        string,
        { busy: Array<{ start?: string; end?: string }>; error: string | null }
      > = {};
      for (const [id, cal] of Object.entries(data.calendars ?? {})) {
        const reasons = (cal.errors ?? []).map((e) => e.reason).filter(Boolean);
        let error: string | null = null;
        if (reasons.includes("notFound")) {
          error =
            "No free/busy visibility into this calendar. Check the email address, or ask the owner to share their calendar.";
        } else if (reasons.length > 0) {
          error = `Free/busy lookup failed for this calendar: ${reasons.join(", ")}.`;
        }
        calendars[id] = { busy: cal.busy ?? [], error };
      }
      // The API can omit a queried ID from the response body entirely;
      // backfill so every queried calendar has an entry.
      for (const id of p.items) {
        if (!(id in calendars)) {
          calendars[id] = {
            busy: [],
            error: "The API returned no result for this calendar. Check the calendar ID.",
          };
        }
      }
      return {
        success: true,
        data: { timeMin: p.timeMin, timeMax: p.timeMax, calendars },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── Plugin export ───────────────────────────────────────────────────────────

export const googleCalendarPlugin: ActionPlugin = {
  service: "google_calendar",
  description: "Google Calendar integration for events and scheduling.",
  actions: [listEvents, createEvent, updateEvent, deleteEvent, quickAdd, queryFreeBusy],
};
