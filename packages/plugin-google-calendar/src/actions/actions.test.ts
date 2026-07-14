import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from '@valet/engine';
import { googleCalendarPlugin } from './actions.js';

type FakeSandbox = Partial<Sandbox> & { id: string };

function makeCredentials(token: string | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => (token === null ? null : { accessToken: token }),
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials('test-token'),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function pluginCtx(overrides: Partial<ToolContext> = {}) {
  return { ...makeCtx(overrides), actionId: '', service: 'google_calendar' };
}

function action(id: string) {
  const found = googleCalendarPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('google-calendar actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list_events lists events with defaults applied and maps the result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Standup',
            start: { dateTime: '2026-04-15T09:00:00-07:00' },
            end: { dateTime: '2026-04-15T09:15:00-07:00' },
            attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
            organizer: { email: 'owner@example.com' },
            htmlLink: 'https://calendar.google.com/e1',
          },
        ],
        nextPageToken: 'np1',
      }),
    );

    const result = await action('calendar.list_events').execute({}, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/);
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('maxResults')).toBe('25');
    expect(qs.get('singleEvents')).toBe('true');
    expect(qs.get('orderBy')).toBe('startTime');
    expect(qs.has('timeMin')).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    expect(result).toEqual({
      success: true,
      data: {
        events: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Standup',
            description: null,
            location: null,
            start: { dateTime: '2026-04-15T09:00:00-07:00' },
            end: { dateTime: '2026-04-15T09:15:00-07:00' },
            attendees: [{ email: 'a@example.com', responseStatus: 'accepted', optional: false }],
            organizer: 'owner@example.com',
            htmlLink: 'https://calendar.google.com/e1',
            recurringEventId: null,
          },
        ],
        count: 1,
        nextPageToken: 'np1',
      },
    });
  });

  it('list_events maps a 403 response to a permission error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const result = await action('calendar.list_events').execute({}, pluginCtx());

    expect(result).toEqual({
      success: false,
      error: 'Permission denied. Confirm the calendar.events scope was granted.',
    });
  });

  it('returns "Missing access token" without calling fetch when no credential is stored', async () => {
    const result = await action('calendar.list_events').execute(
      {},
      pluginCtx({ credentials: makeCredentials(null) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing access token' });
  });

  it('create_event posts the event body and returns the mapped result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'e2',
        summary: 'Lunch',
        start: { dateTime: '2026-04-16T12:00:00-07:00' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e2',
        attendees: [{ email: 'a@example.com' }],
      }),
    );

    const result = await action('calendar.create_event').execute(
      {
        summary: 'Lunch',
        start: { dateTime: '2026-04-16T12:00:00-07:00' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
        attendees: [{ email: 'a@example.com' }],
      },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none',
    );
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      summary: 'Lunch',
      start: { dateTime: '2026-04-16T12:00:00-07:00' },
      end: { dateTime: '2026-04-16T13:00:00-07:00' },
      attendees: [{ email: 'a@example.com' }],
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: 'e2',
        summary: 'Lunch',
        start: { dateTime: '2026-04-16T12:00:00-07:00' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e2',
        hangoutLink: null,
        attendees: 1,
        message: 'Event "Lunch" created.',
      },
    });
  });

  it('create_event rejects start/end objects missing both dateTime and date', async () => {
    const result = await action('calendar.create_event').execute(
      {
        summary: 'Bad event',
        start: { timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
      },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'Provide either dateTime (timed event) or date (all-day event).',
    });
  });

  it('update_event patches only provided fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'e3',
        summary: 'Renamed',
        start: { dateTime: '2026-04-16T12:00:00-07:00' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e3',
        updated: '2026-04-15T00:00:00Z',
      }),
    );

    const result = await action('calendar.update_event').execute(
      { eventId: 'e3', summary: 'Renamed' },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/e3?sendUpdates=none',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ summary: 'Renamed' });

    expect(result).toEqual({
      success: true,
      data: {
        id: 'e3',
        summary: 'Renamed',
        start: { dateTime: '2026-04-16T12:00:00-07:00' },
        end: { dateTime: '2026-04-16T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e3',
        updated: '2026-04-15T00:00:00Z',
        message: 'Event e3 updated.',
      },
    });
  });

  it('update_event returns an error when no fields are provided', async () => {
    const result = await action('calendar.update_event').execute({ eventId: 'e3' }, pluginCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error:
        'No fields provided to update. Pass at least one of summary, description, location, start, end, or attendees.',
    });
  });

  it('delete_event issues a DELETE and returns a confirmation message', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await action('calendar.delete_event').execute({ eventId: 'e4' }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/e4?sendUpdates=none',
    );
    expect(init.method).toBe('DELETE');

    expect(result).toEqual({
      success: true,
      data: {
        eventId: 'e4',
        calendarId: 'primary',
        message: 'Event e4 deleted from calendar primary.',
      },
    });
  });

  it('delete_event maps a 410 response to an "already deleted" error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));

    const result = await action('calendar.delete_event').execute({ eventId: 'e4' }, pluginCtx());

    expect(result).toEqual({ success: false, error: 'Event e4 was already deleted.' });
  });

  it('quick_add posts the text and returns the mapped result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'e5',
        summary: 'Lunch with Sarah',
        start: { dateTime: '2026-04-17T12:00:00-07:00' },
        end: { dateTime: '2026-04-17T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e5',
      }),
    );

    const result = await action('calendar.quick_add').execute(
      { text: 'Lunch with Sarah tomorrow at 12pm' },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events/quickAdd?')).toBe(
      true,
    );
    expect(qs.get('text')).toBe('Lunch with Sarah tomorrow at 12pm');
    expect(qs.get('sendUpdates')).toBe('none');
    expect(init.method).toBe('POST');

    expect(result).toEqual({
      success: true,
      data: {
        id: 'e5',
        summary: 'Lunch with Sarah',
        start: { dateTime: '2026-04-17T12:00:00-07:00' },
        end: { dateTime: '2026-04-17T13:00:00-07:00' },
        htmlLink: 'https://calendar.google.com/e5',
        message: 'Event "Lunch with Sarah" created from "Lunch with Sarah tomorrow at 12pm".',
      },
    });
  });

  it('quick_add maps a 400 response to a parse error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    const result = await action('calendar.quick_add').execute({ text: 'gibberish' }, pluginCtx());

    expect(result).toEqual({
      success: false,
      error: 'Calendar could not parse "gibberish" as an event. Try a clearer time format.',
    });
  });
});
