import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@valet/sdk';
import { googleCalendarActions } from './actions.js';

const fetchMock = vi.fn();

function jsonOk(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

function ctx(): ActionContext {
  return { credentials: { access_token: 'ya29-fake' }, userId: 'user-1' };
}

/** URL and parsed JSON body of the most recent fetch call. */
function lastCall(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  const raw = init?.body;
  const body = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : {};
  return { url, body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calendar.create_event eventType/colorId', () => {
  it('passes eventType and colorId into the insert body when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        id: 'evt-1',
        summary: 'Deep work',
        eventType: 'focusTime',
        colorId: '5',
        htmlLink: 'https://cal/evt-1',
      }),
    );

    const result = await googleCalendarActions.execute(
      'calendar.create_event',
      {
        summary: 'Deep work',
        start: { dateTime: '2026-04-15T14:00:00-08:00' },
        end: { dateTime: '2026-04-15T15:00:00-08:00' },
        eventType: 'focusTime',
        colorId: '5',
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body.eventType).toBe('focusTime');
    expect(body.colorId).toBe('5');
    // Returned event carries the fields.
    const data = result.data as { eventType: unknown; colorId: unknown };
    expect(data.eventType).toBe('focusTime');
    expect(data.colorId).toBe('5');
  });

  it('omits eventType and colorId from the insert body when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: 'evt-2', summary: 'Sync' }));

    const result = await googleCalendarActions.execute(
      'calendar.create_event',
      {
        summary: 'Sync',
        start: { dateTime: '2026-04-15T14:00:00-08:00' },
        end: { dateTime: '2026-04-15T15:00:00-08:00' },
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body).not.toHaveProperty('eventType');
    expect(body).not.toHaveProperty('colorId');
    // Returned event exposes the fields as null when the API omits them.
    const data = result.data as { eventType: unknown; colorId: unknown };
    expect(data.eventType).toBeNull();
    expect(data.colorId).toBeNull();
  });
});

describe('calendar.update_event eventType/colorId', () => {
  it('passes eventType and colorId into the patch body when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ id: 'evt-1', summary: 'Deep work', eventType: 'outOfOffice', colorId: '11' }),
    );

    const result = await googleCalendarActions.execute(
      'calendar.update_event',
      { eventId: 'evt-1', eventType: 'outOfOffice', colorId: '11' },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body.eventType).toBe('outOfOffice');
    expect(body.colorId).toBe('11');
    const data = result.data as { eventType: unknown; colorId: unknown };
    expect(data.eventType).toBe('outOfOffice');
    expect(data.colorId).toBe('11');
  });

  it('omits eventType and colorId from the patch body when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: 'evt-1', summary: 'Renamed' }));

    const result = await googleCalendarActions.execute(
      'calendar.update_event',
      { eventId: 'evt-1', summary: 'Renamed' },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body).toHaveProperty('summary');
    expect(body).not.toHaveProperty('eventType');
    expect(body).not.toHaveProperty('colorId');
  });
});

describe('calendar.list_events eventTypes filter', () => {
  it('forwards each eventTypes value as a repeated query parameter', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        items: [
          {
            id: 'evt-1',
            summary: 'Focus block',
            eventType: 'focusTime',
            colorId: '5',
          },
        ],
      }),
    );

    const result = await googleCalendarActions.execute(
      'calendar.list_events',
      { eventTypes: ['focusTime', 'outOfOffice'] },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { url } = lastCall();
    const params = new URL(url).searchParams;
    expect(params.getAll('eventTypes')).toEqual(['focusTime', 'outOfOffice']);

    // Returned events carry eventType and colorId.
    const data = result.data as { events: Array<{ eventType: unknown; colorId: unknown }> };
    expect(data.events[0].eventType).toBe('focusTime');
    expect(data.events[0].colorId).toBe('5');
  });

  it('does not send an eventTypes query parameter when the filter is omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ items: [] }));

    const result = await googleCalendarActions.execute('calendar.list_events', {}, ctx());

    expect(result.success).toBe(true);
    const { url } = lastCall();
    expect(new URL(url).searchParams.has('eventTypes')).toBe(false);
  });
});
