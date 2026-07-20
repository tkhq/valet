import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSheetsAction } from '../sheets-actions.js';

describe('executeSheetsAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a structured Sheets API error when clear_range receives a 401', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Request had invalid authentication credentials.' } }),
      { status: 401, statusText: 'Unauthorized' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeSheetsAction(
      'sheets.clear_range',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      { credentials: { access_token: 'stale-token' }, userId: 'user-1' },
    );

    expect(result).toEqual({
      success: false,
      error: 'Sheets API 401: Request had invalid authentication credentials.',
    });
  });

  it.each([
    ['an empty array', [] as unknown[][]],
    ['a single empty row', [[]] as unknown[][]],
    ['only empty rows', [[], []] as unknown[][]],
  ])('rejects write_spreadsheet with %s instead of blanking the range', async (_label, data) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeSheetsAction(
      'sheets.write_spreadsheet',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6', data },
      { credentials: { access_token: 'token' }, userId: 'user-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty data payload/i);
    // Nothing should be written to the Sheets API.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still writes a non-empty payload', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ updatedCells: 2 }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeSheetsAction(
      'sheets.write_spreadsheet',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1', data: [['a', 'b']] },
      { credentials: { access_token: 'token' }, userId: 'user-1' },
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
