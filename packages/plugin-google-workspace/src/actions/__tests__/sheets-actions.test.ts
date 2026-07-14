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
import { sheetsActions } from '../sheets-actions.js';

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
  return { ...makeCtx(overrides), actionId: '', service: 'google_workspace' };
}

function action(id: string) {
  const found = sheetsActions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Response shape resolveSheetId expects. */
function sheetPropsResponse(sheets: Array<{ sheetId: number; title: string }>) {
  return jsonResponse(200, { sheets: sheets.map((s) => ({ properties: s })) });
}

describe('sheets actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Missing token ──────────────────────────────────────────────────────

  it('returns "Missing access token" without calling fetch when no credential is stored', async () => {
    const result = await action('sheets.read_spreadsheet').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1' },
      pluginCtx({ credentials: makeCredentials(null) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing access token' });
  });

  // ── Core Data ────────────────────────────────────────────────────────────

  it('read_spreadsheet GETs the range with default valueRenderOption', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { range: 'Sheet1!A1:B2', values: [[1, 2]] }),
    );

    const result = await action('sheets.read_spreadsheet').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:B2' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/ss1/values/Sheet1!A1%3AB2?valueRenderOption=FORMATTED_VALUE`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result).toEqual({ success: true, data: { range: 'Sheet1!A1:B2', values: [[1, 2]] } });
  });

  it('read_spreadsheet maps a 403 response to a Sheets API error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403, statusText: 'Forbidden' }));

    const result = await action('sheets.read_spreadsheet').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Error: Failed to read range: 403' });
  });

  it('write_spreadsheet PUTs values with default USER_ENTERED input option', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { updatedRange: 'Sheet1!A1:B1' }));

    const result = await action('sheets.write_spreadsheet').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:B1', data: [['a', 'b']] },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/ss1/values/Sheet1!A1%3AB1?valueInputOption=USER_ENTERED`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      range: 'Sheet1!A1:B1',
      majorDimension: 'ROWS',
      values: [['a', 'b']],
    });
    expect(result).toEqual({ success: true, data: { updatedRange: 'Sheet1!A1:B1' } });
  });

  it('append_rows POSTs to the :append endpoint with INSERT_ROWS', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { updates: { updatedRange: 'Sheet1!A2:B2' } }));

    const result = await action('sheets.append_rows').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:B1', data: [['x', 1]] },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${SHEETS_API}/ss1/values/Sheet1!A1%3AB1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ majorDimension: 'ROWS', values: [['x', 1]] });
    expect(result).toEqual({ success: true, data: { updates: { updatedRange: 'Sheet1!A2:B2' } } });
  });

  it('create_spreadsheet POSTs properties and initial sheet titles', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { spreadsheetId: 'new1' }));

    const result = await action('sheets.create_spreadsheet').execute(
      { title: 'Budget', sheetTitles: ['Jan', 'Feb'] },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SHEETS_API);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      properties: { title: 'Budget' },
      sheets: [{ properties: { title: 'Jan' } }, { properties: { title: 'Feb' } }],
    });
    expect(result).toEqual({ success: true, data: { spreadsheetId: 'new1' } });
  });

  it('get_spreadsheet_info maps title/url/sheets', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        spreadsheetId: 'ss1',
        properties: { title: 'Budget' },
        sheets: [
          {
            properties: {
              title: 'Sheet1',
              sheetId: 0,
              gridProperties: { rowCount: 100, columnCount: 26 },
              hidden: false,
            },
          },
        ],
      }),
    );

    const result = await action('sheets.get_spreadsheet_info').execute({ spreadsheetId: 'ss1' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: {
        title: 'Budget',
        spreadsheetId: 'ss1',
        url: 'https://docs.google.com/spreadsheets/d/ss1',
        sheets: [{ title: 'Sheet1', sheetId: 0, rows: 100, columns: 26, hidden: false }],
      },
    });
  });

  it('list_spreadsheets queries the Drive API for spreadsheet mimeType', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        files: [{ id: 'ss1', name: 'Budget', modifiedTime: 't1', webViewLink: 'url1' }],
      }),
    );

    const result = await action('sheets.list_spreadsheets').execute({ query: 'Budget' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('https://www.googleapis.com/drive/v3/files?');
    expect(url).toContain("mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27");
    expect(result).toEqual({
      success: true,
      data: { spreadsheets: [{ id: 'ss1', name: 'Budget', modifiedTime: 't1', url: 'url1' }] },
    });
  });

  it('list_spreadsheets maps a Drive API error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' }));

    const result = await action('sheets.list_spreadsheets').execute({}, pluginCtx());

    expect(result).toEqual({ success: false, error: 'Drive API 500: nope' });
  });

  it('batch_write posts multiple ranges to values:batchUpdate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { totalUpdatedCells: 4 }));

    const result = await action('sheets.batch_write').execute(
      {
        spreadsheetId: 'ss1',
        data: [{ range: 'A1:B1', values: [[1, 2]] }],
      },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/ss1/values:batchUpdate`);
    expect(JSON.parse(init.body as string)).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: 'A1:B1', values: [[1, 2]] }],
    });
    expect(result).toEqual({ success: true, data: { totalUpdatedCells: 4 } });
  });

  it('batch_write maps a 400 response to a Sheets API error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid range' } }), { status: 400 }),
    );

    const result = await action('sheets.batch_write').execute(
      { spreadsheetId: 'ss1', data: [{ range: 'A1', values: [[1]] }] },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Sheets API 400: Invalid range' });
  });

  it('clear_range POSTs to the :clear endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { clearedRange: 'Sheet1!A1:B2' }));

    const result = await action('sheets.clear_range').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:B2' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/ss1/values/Sheet1!A1%3AB2:clear`);
    expect(init.method).toBe('POST');
    expect(result).toEqual({ success: true, data: { clearedRange: 'Sheet1!A1:B2' } });
  });

  // ── Sheet Management ─────────────────────────────────────────────────────

  it('add_sheet batchUpdates addSheet and returns the new properties', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { replies: [{ addSheet: { properties: { sheetId: 1, title: 'New' } } }] }),
    );

    const result = await action('sheets.add_sheet').execute({ spreadsheetId: 'ss1', title: 'New' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/ss1:batchUpdate`);
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ addSheet: { properties: { title: 'New' } } }],
    });
    expect(result).toEqual({ success: true, data: { sheetId: 1, title: 'New' } });
  });

  it('delete_sheet batchUpdates deleteSheet', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.delete_sheet').execute({ spreadsheetId: 'ss1', sheetId: 2 }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ requests: [{ deleteSheet: { sheetId: 2 } }] });
    expect(result).toEqual({ success: true });
  });

  it('rename_sheet batchUpdates updateSheetProperties title', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.rename_sheet').execute(
      { spreadsheetId: 'ss1', sheetId: 0, title: 'Renamed' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'Renamed' }, fields: 'title' } }],
    });
    expect(result).toEqual({ success: true, data: { sheetId: 0, title: 'Renamed' } });
  });

  it('duplicate_sheet batchUpdates duplicateSheet with newSheetName', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { replies: [{ duplicateSheet: { properties: { sheetId: 3, title: 'Copy' } } }] }),
    );

    const result = await action('sheets.duplicate_sheet').execute(
      { spreadsheetId: 'ss1', sheetId: 0, title: 'Copy' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ duplicateSheet: { sourceSheetId: 0, newSheetName: 'Copy' } }],
    });
    expect(result).toEqual({ success: true, data: { sheetId: 3, title: 'Copy' } });
  });

  it('copy_sheet_to POSTs to the :copyTo endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sheetId: 9 }));

    const result = await action('sheets.copy_sheet_to').execute(
      { sourceSpreadsheetId: 'src1', sheetId: 0, destinationSpreadsheetId: 'dst1' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SHEETS_API}/src1/sheets/0:copyTo`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ destinationSpreadsheetId: 'dst1' });
    expect(result).toEqual({ success: true, data: { sheetId: 9 } });
  });

  // ── Cell Formatting ──────────────────────────────────────────────────────

  it('format_cells resolves the sheet then repeats cell format via batchUpdate', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.format_cells').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:B1', format: { bold: true, backgroundColor: '#FF0000' } },
      pluginCtx(),
    );

    const [, batchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(batchInit.body as string);
    expect(body.requests[0].repeatCell.cell.userEnteredFormat.textFormat.bold).toBe(true);
    expect(body.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({
      red: 1,
      green: 0,
      blue: 0,
      alpha: 1,
    });
    expect(result).toEqual({ success: true, data: { updatedRange: 'Sheet1!A1:B1' } });
  });

  it('read_cell_format simplifies raw userEnteredFormat into a cell list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sheets: [
          {
            data: [
              {
                startRow: 0,
                startColumn: 0,
                rowData: [{ values: [{ userEnteredFormat: { textFormat: { bold: true } } }] }],
              },
            ],
          },
        ],
      }),
    );

    const result = await action('sheets.read_cell_format').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: { range: 'Sheet1!A1', cells: [{ cell: 'A1', format: { textFormat: { bold: true } } }] },
    });
  });

  it('copy_formatting resolves both sheets then PASTE_FORMAT copyPastes', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 1, title: 'Sheet2' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.copy_formatting').execute(
      { spreadsheetId: 'ss1', sourceRange: 'Sheet1!A1:B1', destinationRange: 'Sheet2!A1:B1' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].copyPaste.pasteType).toBe('PASTE_FORMAT');
    expect(result).toEqual({
      success: true,
      data: { source: 'Sheet1!A1:B1', destination: 'Sheet2!A1:B1' },
    });
  });

  it('set_column_widths resolves the sheet then updates dimension pixel sizes', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.set_column_widths').execute(
      { spreadsheetId: 'ss1', columnWidths: [{ column: 'A', width: 120 }] },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].updateDimensionProperties.range).toEqual({
      sheetId: 0,
      dimension: 'COLUMNS',
      startIndex: 0,
      endIndex: 1,
    });
    expect(result).toEqual({ success: true, data: { columnWidths: [{ column: 'A', width: 120 }] } });
  });

  it('set_row_heights resolves the sheet then updates dimension pixel sizes', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.set_row_heights').execute(
      { spreadsheetId: 'ss1', rowHeights: [{ startRow: 1, endRow: 3, height: 30 }] },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].updateDimensionProperties.range).toEqual({
      sheetId: 0,
      dimension: 'ROWS',
      startIndex: 0,
      endIndex: 3,
    });
    expect(result).toEqual({
      success: true,
      data: { rowHeights: [{ startRow: 1, endRow: 3, height: 30 }] },
    });
  });

  it('auto_resize_columns resolves the sheet then autoResizes the column range', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.auto_resize_columns').execute(
      { spreadsheetId: 'ss1', startColumn: 'A', endColumn: 'C' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].autoResizeDimensions.dimensions).toEqual({
      sheetId: 0,
      dimension: 'COLUMNS',
      startIndex: 0,
      endIndex: 3,
    });
    expect(result).toEqual({ success: true, data: { columns: 'A:C' } });
  });

  it('auto_resize_rows resolves the sheet then autoResizes the row range', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.auto_resize_rows').execute(
      { spreadsheetId: 'ss1', startRow: 2, endRow: 5 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].autoResizeDimensions.dimensions).toEqual({
      sheetId: 0,
      dimension: 'ROWS',
      startIndex: 1,
      endIndex: 5,
    });
    expect(result).toEqual({ success: true, data: { rows: '2:5' } });
  });

  it('set_cell_borders resolves the sheet then updateBorders on the parsed range', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.set_cell_borders').execute(
      {
        spreadsheetId: 'ss1',
        range: 'Sheet1!A1:B2',
        borders: { top: { style: 'SOLID', color: '#000000' } },
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].updateBorders.top).toEqual({
      style: 'SOLID',
      colorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } },
    });
    expect(result).toEqual({ success: true, data: { range: 'Sheet1!A1:B2' } });
  });

  it('freeze_rows_and_columns resolves the sheet then updates gridProperties', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.freeze_rows_and_columns').execute(
      { spreadsheetId: 'ss1', frozenRowCount: 1, frozenColumnCount: 2 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].updateSheetProperties.properties.gridProperties).toEqual({
      frozenRowCount: 1,
      frozenColumnCount: 2,
    });
    expect(result).toEqual({ success: true, data: { frozenRowCount: 1, frozenColumnCount: 2 } });
  });

  // ── Tables ───────────────────────────────────────────────────────────────

  it('create_table resolves the sheet then addTable via batchUpdate', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { replies: [{ addTable: { table: { tableId: 't1', name: 'Orders' } } }] }),
    );

    const result = await action('sheets.create_table').execute(
      { spreadsheetId: 'ss1', name: 'Orders', range: 'Sheet1!A1:C10', columns: ['ID', 'Name'] },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].addTable.table).toEqual({
      name: 'Orders',
      range: { sheetId: 0, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 3 },
      columnProperties: [
        { columnIndex: 0, columnName: 'ID' },
        { columnIndex: 1, columnName: 'Name' },
      ],
    });
    expect(result).toEqual({
      success: true,
      data: { tableId: 't1', name: 'Orders', range: 'Sheet1!A1:C10' },
    });
  });

  it('get_table resolves the table from spreadsheet metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sheets: [
          {
            properties: { sheetId: 0, title: 'Sheet1' },
            tables: [
              {
                tableId: 't1',
                name: 'Orders',
                range: { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
                columnProperties: [{ columnIndex: 0, columnName: 'ID' }],
              },
            ],
          },
        ],
      }),
    );

    const result = await action('sheets.get_table').execute(
      { spreadsheetId: 'ss1', tableIdentifier: 'Orders' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: {
        tableId: 't1',
        name: 'Orders',
        sheetName: 'Sheet1',
        sheetId: 0,
        range: 'Sheet1!A1:B3',
        columns: [{ index: 0, name: 'ID' }],
      },
    });
  });

  it('list_tables lists every table across sheets', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sheets: [
          {
            properties: { sheetId: 0, title: 'Sheet1' },
            tables: [
              {
                tableId: 't1',
                name: 'Orders',
                range: { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
              },
            ],
          },
        ],
      }),
    );

    const result = await action('sheets.list_tables').execute({ spreadsheetId: 'ss1' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: {
        count: 1,
        tables: [{ tableId: 't1', name: 'Orders', sheetName: 'Sheet1', range: 'Sheet1!A1:B3' }],
      },
    });
  });

  it('delete_table batchUpdates deleteTable and clears data when deleteData=true', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sheets: [
          {
            properties: { sheetId: 0, title: 'Sheet1' },
            tables: [
              {
                tableId: 't1',
                name: 'Orders',
                range: { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
              },
            ],
          },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { clearedRange: 'Sheet1!A1:B3' }));

    const result = await action('sheets.delete_table').execute(
      { spreadsheetId: 'ss1', tableId: 't1', deleteData: true },
      pluginCtx(),
    );

    const [, batchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(batchInit.body as string)).toEqual({ requests: [{ deleteTable: { tableId: 't1' } }] });
    const [clearUrl] = fetchMock.mock.calls[2] as [string];
    expect(clearUrl).toBe(`${SHEETS_API}/ss1/values/Sheet1!A1%3AB3:clear`);
    expect(result).toEqual({ success: true, data: { tableId: 't1', deleted: true, dataCleared: true } });
  });

  it('update_table_range resolves the table, updates its range, then re-fetches it', async () => {
    const tableMeta = {
      sheets: [
        {
          properties: { sheetId: 0, title: 'Sheet1' },
          tables: [
            {
              tableId: 't1',
              name: 'Orders',
              range: { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
            },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, tableMeta));
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, tableMeta));

    const result = await action('sheets.update_table_range').execute(
      { spreadsheetId: 'ss1', tableId: 't1', range: 'Sheet1!A1:C5' },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      success: true,
      data: { tableId: 't1', name: 'Orders', newRange: 'Sheet1!A1:C5' },
    });
  });

  it('append_table_rows appends values then best-effort expands the table range', async () => {
    const tableMeta = {
      sheets: [
        {
          properties: { sheetId: 0, title: 'Sheet1' },
          tables: [
            {
              tableId: 't1',
              name: 'Orders',
              range: { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
            },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, tableMeta));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { updates: { updatedRange: 'Sheet1!A1:B1' } }));
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.append_table_rows').execute(
      { spreadsheetId: 'ss1', tableId: 't1', values: [['x', 1]] },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: { tableId: 't1', name: 'Orders', rowsAppended: 1, updatedRange: 'Sheet1!A1:B1' },
    });
  });

  // ── Advanced ─────────────────────────────────────────────────────────────

  it('group_rows resolves the sheet then addDimensionGroup', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.group_rows').execute(
      { spreadsheetId: 'ss1', startRow: 2, endRow: 4 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].addDimensionGroup.range).toEqual({
      sheetId: 0,
      dimension: 'ROWS',
      startIndex: 1,
      endIndex: 4,
    });
    expect(result).toEqual({ success: true, data: { rows: '2:4' } });
  });

  it('ungroup_all_rows loops deleteDimensionGroup until it fails', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'no groups' } }), { status: 400 }));

    const result = await action('sheets.ungroup_all_rows').execute({ spreadsheetId: 'ss1' }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ success: true, data: { levelsRemoved: 1 } });
  });

  it('insert_chart resolves the sheet then addChart for a single-range chart', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{ addChart: { chart: { chartId: 42 } } }] }));

    const result = await action('sheets.insert_chart').execute(
      { spreadsheetId: 'ss1', chartType: 'COLUMN', sourceRange: 'Sheet1!A1:B10' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].addChart.chart.spec.basicChart.chartType).toBe('COLUMN');
    expect(result).toEqual({ success: true, data: { chartId: 42 } });
  });

  it('insert_chart rejects PIE charts with fewer than 2 columns', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));

    const result = await action('sheets.insert_chart').execute(
      { spreadsheetId: 'ss1', chartType: 'PIE', sourceRange: 'Sheet1!A1:A10' },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      error:
        'PIE chart requires at least 2 columns (labels + numeric values), but the source range "Sheet1!A1:A10" has only 1 column(s). Provide a range like "Sheet!A1:B10" where the first column has labels and the second has numeric values.',
    });
  });

  it('delete_chart batchUpdates deleteEmbeddedObject', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.delete_chart').execute({ spreadsheetId: 'ss1', chartId: 7 }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ deleteEmbeddedObject: { objectId: 7 } }],
    });
    expect(result).toEqual({ success: true, data: { chartId: 7, deleted: true } });
  });

  it('add_conditional_formatting resolves the sheet then addConditionalFormatRule', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.add_conditional_formatting').execute(
      {
        spreadsheetId: 'ss1',
        range: 'Sheet1!A1:A10',
        conditionType: 'NUMBER_GREATER',
        conditionValues: ['10'],
        format: { bold: true },
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].addConditionalFormatRule.rule.booleanRule.condition).toEqual({
      type: 'NUMBER_GREATER',
      values: [{ userEnteredValue: '10' }],
    });
    expect(body.requests[0].addConditionalFormatRule.rule.booleanRule.format.textFormat).toEqual({ bold: true });
    expect(result).toEqual({ success: true, data: { range: 'Sheet1!A1:A10' } });
  });

  it('delete_conditional_formatting batchUpdates deleteConditionalFormatRule', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.delete_conditional_formatting').execute(
      { spreadsheetId: 'ss1', sheetId: 0, index: 1 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ deleteConditionalFormatRule: { sheetId: 0, index: 1 } }],
    });
    expect(result).toEqual({ success: true, data: { sheetId: 0, index: 1, deleted: true } });
  });

  it('get_conditional_formatting resolves the sheet then summarizes its rules', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sheets: [
          {
            properties: { sheetId: 0, title: 'Sheet1' },
            conditionalFormats: [
              {
                booleanRule: {
                  condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '10' }] },
                  format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
                },
                ranges: [{ startColumnIndex: 0, endColumnIndex: 1, startRowIndex: 0, endRowIndex: 10 }],
              },
            ],
          },
        ],
      }),
    );

    const result = await action('sheets.get_conditional_formatting').execute(
      { spreadsheetId: 'ss1' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: {
        sheetName: 'Sheet1',
        count: 1,
        rules: [
          {
            index: 0,
            kind: 'BOOLEAN',
            ranges: ['A1:A10'],
            conditionType: 'NUMBER_GREATER',
            conditionValues: ['10'],
            backgroundColor: '#FF0000',
            textColor: null,
            bold: false,
            italic: false,
          },
        ],
      },
    });
  });

  it('set_dropdown_validation resolves the sheet then setDataValidation with ONE_OF_LIST', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.set_dropdown_validation').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:A10', values: ['Yes', 'No'] },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].setDataValidation.rule.condition).toEqual({
      type: 'ONE_OF_LIST',
      values: [{ userEnteredValue: 'Yes' }, { userEnteredValue: 'No' }],
    });
    expect(result).toEqual({
      success: true,
      data: { range: 'Sheet1!A1:A10', action: 'set', optionCount: 2 },
    });
  });

  it('set_dropdown_validation clears the rule when values are omitted', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('sheets.set_dropdown_validation').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:A10' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].setDataValidation.rule).toBeUndefined();
    expect(result).toEqual({ success: true, data: { range: 'Sheet1!A1:A10', action: 'cleared' } });
  });

  it('protect_range resolves the sheet then addProtectedRange', async () => {
    fetchMock.mockResolvedValueOnce(sheetPropsResponse([{ sheetId: 0, title: 'Sheet1' }]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { replies: [{ addProtectedRange: { protectedRange: { protectedRangeId: 5 } } }] }),
    );

    const result = await action('sheets.protect_range').execute(
      { spreadsheetId: 'ss1', range: 'Sheet1!A1:A10', description: 'locked' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].addProtectedRange.protectedRange).toEqual({
      description: 'locked',
      warningOnly: false,
      range: { sheetId: 0, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 },
    });
    expect(result).toEqual({
      success: true,
      data: { protectedRangeId: 5, range: 'Sheet1!A1:A10', warningOnly: false },
    });
  });
});
