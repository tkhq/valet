/**
 * Google Sheets actions — 37 total (core data, sheet management, cell
 * formatting, tables, advanced features).
 *
 * Ported from the reference MCP server tools. Uses raw fetch() via
 * sheets-helpers.ts.
 */

import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import type {
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from '@valet/engine';
import {
  sheetsFetch,
  sheetsError,
  resolveSheetId,
  parseRange,
  parseA1ToGridRange,
  colLettersToIndex,
  colIndexToLetters,
  rowColToA1,
  rgbToHex,
  normalizeColor,
  sheetsBatchUpdate,
  readRange,
  writeRange,
  appendValues,
  clearRange,
  formatCells,
  freezeRowsAndColumns,
  setColumnWidths,
  setDropdownValidation,
  addConditionalFormatRule,
  resolveTableIdentifier,
  listAllTables,
} from './sheets-helpers.js';

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
    riskLevel: PluginAction['riskLevel'];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

// ─── Credential Helper ─────────────────────────────────────────────────────────

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? '';
}

/**
 * Read __labelFilter from raw params for list/search actions.
 * The labels guard injects this to restrict results to labeled files.
 * V2-GAP: the guard that injects this (see actions.ts) is currently a
 * documented no-op (ctx.guardConfig doesn't exist in v2 yet), so this always
 * reads undefined today. Left in place so re-enabling the guard wrapper in
 * actions.ts makes this live again without touching action bodies.
 */
function getLabelFilter(params: unknown): string | undefined {
  return (params as Record<string, unknown> | null)?.__labelFilter as string | undefined;
}

// ─── Shared Schemas ───────────────────────────────────────────────────────

/** Color input: accepts hex string "#FF0000" or RGB object {red, green, blue} with 0-1 values. */
const colorInput = Type.Union([
  Type.String({ description: 'Hex color string, e.g. "#FF0000"' }),
  Type.Object(
    { red: Type.Number(), green: Type.Number(), blue: Type.Number() },
    { description: 'RGB object with 0-1 values' },
  ),
]);

const cellValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

// ─── Helpers for readCellFormat simplification ─────────────────────────────

function simplifyFormat(fmt: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!fmt) return null;
  const result: Record<string, unknown> = {};

  if (fmt.textFormat) {
    const tf = fmt.textFormat as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (tf.bold) out.bold = true;
    if (tf.italic) out.italic = true;
    if (tf.strikethrough) out.strikethrough = true;
    if (tf.underline) out.underline = true;
    if (tf.fontSize != null) out.fontSize = tf.fontSize;
    if (tf.fontFamily) out.fontFamily = tf.fontFamily;
    const fgStyle = tf.foregroundColorStyle as { rgbColor?: Record<string, number> } | undefined;
    if (fgStyle?.rgbColor) {
      out.foregroundColor = rgbToHex(fgStyle.rgbColor);
    } else if (tf.foregroundColor) {
      out.foregroundColor = rgbToHex(tf.foregroundColor as Record<string, number>);
    }
    if (Object.keys(out).length > 0) result.textFormat = out;
  }

  const bgStyle = (fmt.backgroundColorStyle as { rgbColor?: Record<string, number> }) || undefined;
  if (bgStyle?.rgbColor) {
    result.backgroundColor = rgbToHex(bgStyle.rgbColor);
  } else if (fmt.backgroundColor) {
    result.backgroundColor = rgbToHex(fmt.backgroundColor as Record<string, number>);
  }

  if (fmt.horizontalAlignment) result.horizontalAlignment = fmt.horizontalAlignment;
  if (fmt.verticalAlignment) result.verticalAlignment = fmt.verticalAlignment;
  if (fmt.numberFormat) result.numberFormat = fmt.numberFormat;

  if (fmt.borders) {
    const borders: Record<string, unknown> = {};
    const b = fmt.borders as Record<string, Record<string, unknown>>;
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      if (b[side]) {
        const sideObj: Record<string, unknown> = { style: b[side].style };
        const cs = b[side].colorStyle as { rgbColor?: Record<string, number> } | undefined;
        if (cs?.rgbColor) {
          sideObj.color = rgbToHex(cs.rgbColor);
        } else if (b[side].color) {
          sideObj.color = rgbToHex(b[side].color as Record<string, number>);
        }
        borders[side] = sideObj;
      }
    }
    if (Object.keys(borders).length > 0) result.borders = borders;
  }

  if (fmt.wrapStrategy) result.wrapStrategy = fmt.wrapStrategy;

  return Object.keys(result).length > 0 ? result : null;
}

// ─── Action Definitions ────────────────────────────────────────────────────

// -- Core Data (8) -----------------------------------------------------------

const readSpreadsheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range (e.g. "Sheet1!A1:D10")' }),
    valueRenderOption: Type.Optional(
      Type.Union(
        [Type.Literal('FORMATTED_VALUE'), Type.Literal('UNFORMATTED_VALUE'), Type.Literal('FORMULA')],
        { description: 'How values should be rendered (default: FORMATTED_VALUE)' },
      ),
    ),
  }),
)({
  id: 'sheets.read_spreadsheet',
  name: 'Read Spreadsheet',
  description: 'Read data from a range in a spreadsheet. Returns rows as arrays.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await readRange(token, p.spreadsheetId, p.range, p.valueRenderOption);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const writeSpreadsheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
    data: Type.Array(Type.Array(cellValue), { description: '2D array of values' }),
    valueInputOption: Type.Optional(
      Type.Union([Type.Literal('RAW'), Type.Literal('USER_ENTERED')], {
        description: 'How input should be interpreted (default: USER_ENTERED)',
      }),
    ),
  }),
)({
  id: 'sheets.write_spreadsheet',
  name: 'Write Spreadsheet',
  description: 'Write data to a range, overwriting existing values. Use append_rows to add without overwriting.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await writeRange(token, p.spreadsheetId, p.range, p.data, p.valueInputOption);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const appendRowsDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range to search for data' }),
    data: Type.Array(Type.Array(cellValue), { description: '2D array of rows' }),
    valueInputOption: Type.Optional(
      Type.Union([Type.Literal('RAW'), Type.Literal('USER_ENTERED')], {
        description: 'How input should be interpreted (default: USER_ENTERED)',
      }),
    ),
  }),
)({
  id: 'sheets.append_rows',
  name: 'Append Rows',
  description: 'Append rows after the last row with data in a range.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await appendValues(token, p.spreadsheetId, p.range, p.data, p.valueInputOption);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const createSpreadsheet = action(
  Type.Object({
    title: Type.String({ description: 'Spreadsheet title' }),
    sheetTitles: Type.Optional(Type.Array(Type.String(), { description: 'Initial sheet names' })),
  }),
)({
  id: 'sheets.create_spreadsheet',
  name: 'Create Spreadsheet',
  description: 'Create a new spreadsheet with a title and optional sheet names.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const body: Record<string, unknown> = {
        properties: { title: p.title },
      };
      if (p.sheetTitles?.length) {
        body.sheets = p.sheetTitles.map((t: string) => ({ properties: { title: t } }));
      }
      const res = await sheetsFetch('', token, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) return sheetsError(res);
      return { success: true, data: await res.json() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const getSpreadsheetInfo = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
  }),
)({
  id: 'sheets.get_spreadsheet_info',
  name: 'Get Spreadsheet Info',
  description: 'Get spreadsheet metadata including title, URL, and a list of all sheets with dimensions.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const qs = new URLSearchParams({
        fields: 'spreadsheetId,properties,sheets.properties',
      });
      const res = await sheetsFetch(`/${encodeURIComponent(p.spreadsheetId)}?${qs}`, token);
      if (!res.ok) return sheetsError(res);
      const data = await res.json() as {
        spreadsheetId: string;
        properties: { title: string };
        sheets: Array<{
          properties: {
            title: string;
            sheetId: number;
            gridProperties?: { rowCount: number; columnCount: number };
            hidden?: boolean;
          };
        }>;
      };
      return {
        success: true,
        data: {
          title: data.properties?.title || 'Untitled',
          spreadsheetId: data.spreadsheetId,
          url: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`,
          sheets: (data.sheets || []).map((s) => ({
            title: s.properties?.title,
            sheetId: s.properties?.sheetId,
            rows: s.properties?.gridProperties?.rowCount || 0,
            columns: s.properties?.gridProperties?.columnCount || 0,
            hidden: s.properties?.hidden || false,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const listSpreadsheets = action(
  Type.Object({
    query: Type.Optional(Type.String({ description: 'Search text' })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Max results (default: 20)' })),
  }),
)({
  id: 'sheets.list_spreadsheets',
  name: 'List Spreadsheets',
  description: 'List spreadsheets in your Drive, optionally filtered by name.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const labelFilter = getLabelFilter(args);
      const queryParts: string[] = [
        "mimeType='application/vnd.google-apps.spreadsheet'",
        'trashed=false',
      ];
      if (p.query) {
        queryParts.push(`fullText contains '${p.query.replace(/'/g, "\\'")}'`);
      }
      const userQuery = queryParts.join(' and ');
      let finalQuery: string;
      if (userQuery && labelFilter) {
        finalQuery = `(${userQuery}) and ${labelFilter}`;
      } else if (labelFilter) {
        finalQuery = labelFilter;
      } else {
        finalQuery = userQuery;
      }
      const qs = new URLSearchParams({
        q: finalQuery,
        fields: 'files(id,name,modifiedTime,webViewLink)',
        pageSize: String(p.maxResults || 20),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${qs}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        return { success: false, error: `Drive API ${res.status}: ${detail}` };
      }
      const data = await res.json() as {
        files: Array<{ id: string; name: string; modifiedTime: string; webViewLink: string }>;
      };
      return {
        success: true,
        data: {
          spreadsheets: (data.files || []).map((f) => ({
            id: f.id,
            name: f.name,
            modifiedTime: f.modifiedTime,
            url: f.webViewLink,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const batchWrite = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    data: Type.Array(
      Type.Object({
        range: Type.String({ description: 'A1 notation range' }),
        values: Type.Array(Type.Array(cellValue)),
      }),
      { minItems: 1, description: 'Array of range+values pairs' },
    ),
    valueInputOption: Type.Optional(
      Type.Union([Type.Literal('RAW'), Type.Literal('USER_ENTERED')], {
        description: 'How input should be interpreted (default: USER_ENTERED)',
      }),
    ),
  }),
)({
  id: 'sheets.batch_write',
  name: 'Batch Write',
  description: 'Write data to multiple ranges in a single API call.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const res = await sheetsFetch(
        `/${encodeURIComponent(p.spreadsheetId)}/values:batchUpdate`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: p.valueInputOption || 'USER_ENTERED',
            data: p.data.map((d: { range: string; values: unknown[][] }) => ({ range: d.range, values: d.values })),
          }),
        },
      );
      if (!res.ok) return sheetsError(res);
      return { success: true, data: await res.json() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const clearRangeDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range to clear' }),
  }),
)({
  id: 'sheets.clear_range',
  name: 'Clear Range',
  description: 'Clear all values from a range (formatting is preserved).',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await clearRange(token, p.spreadsheetId, p.range);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// -- Sheet Management (5) ----------------------------------------------------

const addSheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    title: Type.String({ description: 'Sheet/tab title' }),
  }),
)({
  id: 'sheets.add_sheet',
  name: 'Add Sheet',
  description: 'Add a new sheet/tab to an existing spreadsheet.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
        { addSheet: { properties: { title: p.title } } },
      ]);
      const replies = (data as { replies?: Array<{ addSheet?: { properties?: unknown } }> }).replies;
      return { success: true, data: replies?.[0]?.addSheet?.properties };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteSheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetId: Type.Integer({ description: 'Numeric sheet ID (from get_spreadsheet_info)' }),
  }),
)({
  id: 'sheets.delete_sheet',
  name: 'Delete Sheet',
  description: 'Delete a sheet/tab from a spreadsheet by its numeric sheet ID.',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        { deleteSheet: { sheetId: p.sheetId } },
      ]);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const renameSheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetId: Type.Integer({ description: 'Numeric sheet ID' }),
    title: Type.String({ description: 'New sheet title' }),
  }),
)({
  id: 'sheets.rename_sheet',
  name: 'Rename Sheet',
  description: 'Rename a sheet/tab in a spreadsheet.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          updateSheetProperties: {
            properties: { sheetId: p.sheetId, title: p.title },
            fields: 'title',
          },
        },
      ]);
      return { success: true, data: { sheetId: p.sheetId, title: p.title } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const duplicateSheet = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetId: Type.Integer({ description: 'Sheet ID to duplicate' }),
    title: Type.Optional(Type.String({ description: 'Title for the copy' })),
  }),
)({
  id: 'sheets.duplicate_sheet',
  name: 'Duplicate Sheet',
  description: 'Duplicate a sheet/tab within a spreadsheet, copying all values, formulas, formatting, and validations.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          duplicateSheet: {
            sourceSheetId: p.sheetId,
            ...(p.title ? { newSheetName: p.title } : {}),
          },
        },
      ]);
      const replies = (data as { replies?: Array<{ duplicateSheet?: { properties?: unknown } }> }).replies;
      return { success: true, data: replies?.[0]?.duplicateSheet?.properties };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const copySheetTo = action(
  Type.Object({
    sourceSpreadsheetId: Type.String({ description: 'Source spreadsheet ID' }),
    sheetId: Type.Integer({ description: 'Sheet ID to copy' }),
    destinationSpreadsheetId: Type.String({ description: 'Target spreadsheet ID' }),
  }),
)({
  id: 'sheets.copy_sheet_to',
  name: 'Copy Sheet To',
  description: 'Copy a sheet/tab from one spreadsheet to another.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const res = await sheetsFetch(
        `/${encodeURIComponent(p.sourceSpreadsheetId)}/sheets/${p.sheetId}:copyTo`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ destinationSpreadsheetId: p.destinationSpreadsheetId }),
        },
      );
      if (!res.ok) return sheetsError(res);
      return { success: true, data: await res.json() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// -- Cell Formatting (9) -----------------------------------------------------

const formatCellsDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
    format: Type.Object(
      {
        backgroundColor: Type.Optional(colorInput),
        // Top-level shortcuts for text formatting (auto-nested into textFormat)
        bold: Type.Optional(Type.Boolean({ description: 'Shortcut: equivalent to textFormat.bold' })),
        italic: Type.Optional(Type.Boolean({ description: 'Shortcut: equivalent to textFormat.italic' })),
        fontSize: Type.Optional(Type.Number({ description: 'Shortcut: equivalent to textFormat.fontSize' })),
        foregroundColor: Type.Optional(
          Type.Union([colorInput], { description: 'Shortcut: equivalent to textFormat.foregroundColor' }),
        ),
        // Nested form still supported
        textFormat: Type.Optional(
          Type.Object({
            foregroundColor: Type.Optional(colorInput),
            fontSize: Type.Optional(Type.Number()),
            bold: Type.Optional(Type.Boolean()),
            italic: Type.Optional(Type.Boolean()),
          }),
        ),
        horizontalAlignment: Type.Optional(
          Type.Union([Type.Literal('LEFT'), Type.Literal('CENTER'), Type.Literal('RIGHT')]),
        ),
        verticalAlignment: Type.Optional(
          Type.Union([Type.Literal('TOP'), Type.Literal('MIDDLE'), Type.Literal('BOTTOM')]),
        ),
        wrapStrategy: Type.Optional(
          Type.Union([Type.Literal('OVERFLOW_CELL'), Type.Literal('CLIP'), Type.Literal('WRAP')]),
        ),
        numberFormat: Type.Optional(
          Type.Object({ type: Type.String(), pattern: Type.Optional(Type.String()) }),
        ),
      },
      { description: 'Cell formatting properties' },
    ),
  }),
)({
  id: 'sheets.format_cells',
  name: 'Format Cells',
  description: 'Apply formatting to a range. Supports bold, italic, font size, colors, alignment, number format, and wrap strategy. Text properties (bold, italic, fontSize, foregroundColor) can be passed at the top level or nested under textFormat.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const fmt = p.format;

      // Merge top-level text shortcuts into textFormat
      const mergedTextFormat = { ...fmt.textFormat };
      if (fmt.bold !== undefined && mergedTextFormat.bold === undefined) mergedTextFormat.bold = fmt.bold;
      if (fmt.italic !== undefined && mergedTextFormat.italic === undefined) mergedTextFormat.italic = fmt.italic;
      if (fmt.fontSize !== undefined && mergedTextFormat.fontSize === undefined) mergedTextFormat.fontSize = fmt.fontSize;
      if (fmt.foregroundColor !== undefined && mergedTextFormat.foregroundColor === undefined) {
        mergedTextFormat.foregroundColor = fmt.foregroundColor;
      }
      const hasTextFormat = mergedTextFormat.bold !== undefined || mergedTextFormat.italic !== undefined
        || mergedTextFormat.fontSize !== undefined || mergedTextFormat.foregroundColor !== undefined;

      // Normalize colors (accept hex strings or RGB objects)
      const bgColor = fmt.backgroundColor ? normalizeColor(fmt.backgroundColor) : undefined;
      const fgColor = mergedTextFormat.foregroundColor ? normalizeColor(mergedTextFormat.foregroundColor) : undefined;

      await formatCells(token, p.spreadsheetId, p.range, {
        backgroundColor: bgColor ?? undefined,
        textFormat: hasTextFormat ? {
          bold: mergedTextFormat.bold,
          italic: mergedTextFormat.italic,
          fontSize: mergedTextFormat.fontSize,
          foregroundColor: fgColor ?? undefined,
        } : undefined,
        horizontalAlignment: fmt.horizontalAlignment,
        verticalAlignment: fmt.verticalAlignment,
        wrapStrategy: fmt.wrapStrategy,
        numberFormat: fmt.numberFormat,
      });
      return { success: true, data: { updatedRange: p.range } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const readCellFormat = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
  }),
)({
  id: 'sheets.read_cell_format',
  name: 'Read Cell Format',
  description: 'Read formatting/style of cells in a range (bold, colors, borders, alignment, number format).',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const fields = [
        'sheets.data.rowData.values.userEnteredFormat',
        'sheets.data.startRow',
        'sheets.data.startColumn',
      ].join(',');
      const qs = new URLSearchParams({
        ranges: p.range,
        includeGridData: 'true',
        fields,
      });
      const res = await sheetsFetch(
        `/${encodeURIComponent(p.spreadsheetId)}?${qs}`,
        token,
      );
      if (!res.ok) return sheetsError(res);

      const apiData = await res.json() as {
        sheets?: Array<{
          data?: Array<{
            startRow?: number;
            startColumn?: number;
            rowData?: Array<{
              values?: Array<{ userEnteredFormat?: Record<string, unknown> }>;
            }>;
          }>;
        }>;
      };

      const sheetData = apiData.sheets?.[0]?.data?.[0];
      if (!sheetData?.rowData) {
        return { success: true, data: { range: p.range, cells: [] } };
      }

      const startRow = sheetData.startRow ?? 0;
      const startCol = sheetData.startColumn ?? 0;
      const cells: Array<{ cell: string; format: Record<string, unknown> }> = [];

      for (let rowIdx = 0; rowIdx < sheetData.rowData.length; rowIdx++) {
        const row = sheetData.rowData[rowIdx];
        if (!row.values) continue;
        for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
          const cellData = row.values[colIdx];
          const fmt = simplifyFormat(cellData?.userEnteredFormat);
          if (fmt) {
            cells.push({ cell: rowColToA1(startRow + rowIdx, startCol + colIdx), format: fmt });
          }
        }
      }

      return { success: true, data: { range: p.range, cells } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const copyFormatting = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sourceRange: Type.String({ description: 'A1 notation source range (including sheet name)' }),
    destinationRange: Type.String({ description: 'A1 notation destination range (including sheet name)' }),
  }),
)({
  id: 'sheets.copy_formatting',
  name: 'Copy Formatting',
  description: 'Copy formatting (not values) from a source range to a destination range within the same spreadsheet.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const srcParsed = parseRange(p.sourceRange);
      const dstParsed = parseRange(p.destinationRange);
      const srcSheetId = await resolveSheetId(token, p.spreadsheetId, srcParsed.sheetName);
      const dstSheetId = await resolveSheetId(token, p.spreadsheetId, dstParsed.sheetName);
      const srcGrid = parseA1ToGridRange(srcParsed.a1Range, srcSheetId);
      const dstGrid = parseA1ToGridRange(dstParsed.a1Range, dstSheetId);

      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          copyPaste: {
            source: srcGrid,
            destination: dstGrid,
            pasteType: 'PASTE_FORMAT',
          },
        },
      ]);
      return { success: true, data: { source: p.sourceRange, destination: p.destinationRange } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const setColumnWidthsDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name (default: first sheet)' })),
    columnWidths: Type.Array(
      Type.Object({
        column: Type.String({ description: 'Column letter(s) or range, e.g. "A" or "A:C"' }),
        width: Type.Number({ description: 'Width in pixels' }),
      }),
      { minItems: 1 },
    ),
  }),
)({
  id: 'sheets.set_column_widths',
  name: 'Set Column Widths',
  description: 'Set the width (in pixels) of one or more columns.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await setColumnWidths(token, p.spreadsheetId, p.sheetName, p.columnWidths);
      return { success: true, data: { columnWidths: p.columnWidths } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const setRowHeights = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name (default: first sheet)' })),
    rowHeights: Type.Array(
      Type.Object({
        startRow: Type.Integer({ description: 'Start row (1-based)' }),
        endRow: Type.Integer({ description: 'End row (1-based, inclusive)' }),
        height: Type.Number({ description: 'Height in pixels' }),
      }),
      { minItems: 1 },
    ),
  }),
)({
  id: 'sheets.set_row_heights',
  name: 'Set Row Heights',
  description: 'Set a fixed pixel height for a range of rows.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      const requests = p.rowHeights.map((rh: { startRow: number; endRow: number; height: number }) => ({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rh.startRow - 1,
            endIndex: rh.endRow,
          },
          properties: { pixelSize: rh.height },
          fields: 'pixelSize',
        },
      }));
      await sheetsBatchUpdate(token, p.spreadsheetId, requests);
      return { success: true, data: { rowHeights: p.rowHeights } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const autoResizeColumns = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
    startColumn: Type.String({ description: 'Start column letter, e.g. "A"' }),
    endColumn: Type.String({ description: 'End column letter, e.g. "D"' }),
  }),
)({
  id: 'sheets.auto_resize_columns',
  name: 'Auto Resize Columns',
  description: 'Auto-resize columns to fit their content.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      const startIndex = colLettersToIndex(p.startColumn);
      const endIndex = colLettersToIndex(p.endColumn) + 1;

      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
          },
        },
      ]);
      return { success: true, data: { columns: `${p.startColumn}:${p.endColumn}` } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const autoResizeRows = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
    startRow: Type.Integer({ description: 'Start row (1-based)' }),
    endRow: Type.Integer({ description: 'End row (1-based, inclusive)' }),
  }),
)({
  id: 'sheets.auto_resize_rows',
  name: 'Auto Resize Rows',
  description: 'Auto-resize rows to fit their content.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: 'ROWS',
              startIndex: p.startRow - 1,
              endIndex: p.endRow,
            },
          },
        },
      ]);
      return { success: true, data: { rows: `${p.startRow}:${p.endRow}` } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const setCellBorders = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
    borders: Type.Object(
      {
        top: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
        bottom: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
        left: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
        right: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
        innerHorizontal: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
        innerVertical: Type.Optional(Type.Object({ style: Type.String(), color: Type.Optional(colorInput) })),
      },
      { description: 'Border styles (style: DOTTED, DASHED, SOLID, SOLID_MEDIUM, SOLID_THICK, DOUBLE, NONE)' },
    ),
  }),
)({
  id: 'sheets.set_cell_borders',
  name: 'Set Cell Borders',
  description: 'Set borders on a range of cells. Each side can be configured independently.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { sheetName, a1Range } = parseRange(p.range);
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);
      const gridRange = parseA1ToGridRange(a1Range, sheetId);

      const buildBorder = (b: { style: string; color?: string | { red: number; green: number; blue: number } } | undefined) => {
        if (!b) return undefined;
        const border: Record<string, unknown> = { style: b.style };
        if (b.color) {
          const rgb = normalizeColor(b.color);
          if (rgb) border.colorStyle = { rgbColor: rgb };
        }
        return border;
      };

      const borders: Record<string, unknown> = {};
      if (p.borders.top !== undefined) borders.top = buildBorder(p.borders.top);
      if (p.borders.bottom !== undefined) borders.bottom = buildBorder(p.borders.bottom);
      if (p.borders.left !== undefined) borders.left = buildBorder(p.borders.left);
      if (p.borders.right !== undefined) borders.right = buildBorder(p.borders.right);
      if (p.borders.innerHorizontal !== undefined) borders.innerHorizontal = buildBorder(p.borders.innerHorizontal);
      if (p.borders.innerVertical !== undefined) borders.innerVertical = buildBorder(p.borders.innerVertical);

      await sheetsBatchUpdate(token, p.spreadsheetId, [
        { updateBorders: { range: gridRange, ...borders } },
      ]);
      return { success: true, data: { range: p.range } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const freezeRowsAndColumnsDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
    frozenRowCount: Type.Optional(Type.Integer({ minimum: 0, description: 'Number of rows to freeze' })),
    frozenColumnCount: Type.Optional(Type.Integer({ minimum: 0, description: 'Number of columns to freeze' })),
  }),
)({
  id: 'sheets.freeze_rows_and_columns',
  name: 'Freeze Rows and Columns',
  description: 'Pin rows and/or columns so they stay visible when scrolling.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await freezeRowsAndColumns(
        token,
        p.spreadsheetId,
        p.sheetName,
        p.frozenRowCount,
        p.frozenColumnCount,
      );
      return {
        success: true,
        data: { frozenRowCount: p.frozenRowCount, frozenColumnCount: p.frozenColumnCount },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// -- Tables (6) --------------------------------------------------------------

const createTable = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name (default: first sheet)' })),
    name: Type.String({ description: 'Table name' }),
    range: Type.String({ description: 'A1 notation range for the table' }),
    columns: Type.Optional(Type.Array(Type.String(), { description: 'Column header names' })),
  }),
)({
  id: 'sheets.create_table',
  name: 'Create Table',
  description: 'Create a new named table with structured columns and optional column types.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { sheetName: rangeSN, a1Range } = parseRange(p.range);
      const sn = p.sheetName || rangeSN;
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sn);
      const gridRange = parseA1ToGridRange(a1Range, sheetId);

      const columnProperties = p.columns?.map((name: string, index: number) => ({
        columnIndex: index,
        columnName: name,
      }));

      const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          addTable: {
            table: {
              name: p.name,
              range: gridRange,
              ...(columnProperties ? { columnProperties } : {}),
            },
          },
        },
      ]);

      const replies = (data as { replies?: Array<{ addTable?: { table?: Record<string, unknown> } }> }).replies;
      const table = replies?.[0]?.addTable?.table;
      return {
        success: true,
        data: {
          tableId: table?.tableId,
          name: table?.name || p.name,
          range: p.range,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const getTable = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    tableIdentifier: Type.String({ description: 'Table ID or name' }),
  }),
)({
  id: 'sheets.get_table',
  name: 'Get Table',
  description: 'Get detailed information about a specific table including its columns, range, and properties.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { table, sheetName, sheetId } = await resolveTableIdentifier(
        token,
        p.spreadsheetId,
        p.tableIdentifier,
      );
      const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;
      const columns = (table.columnProperties as Array<{ columnIndex?: number; columnName?: string }> | undefined)?.map(
        (col) => ({ index: col.columnIndex, name: col.columnName }),
      ) || [];

      const range = tRange
        ? `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`
        : 'Unknown';

      return {
        success: true,
        data: {
          tableId: table.tableId,
          name: table.name,
          sheetName,
          sheetId,
          range,
          columns,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const listTablesDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Filter by sheet name' })),
  }),
)({
  id: 'sheets.list_tables',
  name: 'List Tables',
  description: 'List all tables in a spreadsheet, optionally filtered by sheet.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const tables = await listAllTables(token, p.spreadsheetId, p.sheetName);

      const tableList = tables.map((item) => {
        const tRange = item.table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;
        return {
          tableId: item.table.tableId,
          name: item.table.name,
          sheetName: item.sheetName,
          range: tRange
            ? `${item.sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`
            : 'Unknown',
        };
      });

      return {
        success: true,
        data: { count: tableList.length, tables: tableList },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteTable = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    tableId: Type.String({ description: 'Table ID' }),
    deleteData: Type.Optional(
      Type.Boolean({ description: 'Also clear cell data in the table range (default: false)' }),
    ),
  }),
)({
  id: 'sheets.delete_table',
  name: 'Delete Table',
  description: 'Delete a table from a spreadsheet (table object removed; data preserved unless deleteData is true).',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      // Resolve table to get metadata before deletion
      const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
      const tableId = (table.tableId as string) || p.tableId;
      const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;

      // The Sheets API deleteTable clears underlying cell data as a side effect.
      // When deleteData=false, save the data first so we can restore it after deletion.
      let savedData: unknown[][] | undefined;
      if (!p.deleteData && tRange) {
        const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
        const readResult = await readRange(token, p.spreadsheetId, a1);
        if (readResult.values && readResult.values.length > 0) {
          savedData = readResult.values;
        }
      }

      await sheetsBatchUpdate(token, p.spreadsheetId, [
        { deleteTable: { tableId } },
      ]);

      // Restore cell data if we saved it (deleteData=false)
      if (savedData && tRange) {
        const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
        await writeRange(token, p.spreadsheetId, a1, savedData);
      }

      // Clear data if explicitly requested (and deleteTable didn't already clear it)
      if (p.deleteData && tRange) {
        const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
        await clearRange(token, p.spreadsheetId, a1);
      }

      return {
        success: true,
        data: { tableId, deleted: true, dataCleared: p.deleteData || false },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const updateTableRange = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    tableId: Type.String({ description: 'Table ID' }),
    range: Type.String({ description: 'New A1 notation range for the table' }),
  }),
)({
  id: 'sheets.update_table_range',
  name: 'Update Table Range',
  description: "Modify a table's dimensions by updating its range.",
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
      const { a1Range } = parseRange(p.range);
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName || undefined);
      const newRange = parseA1ToGridRange(a1Range, sheetId);

      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          updateTable: {
            table: { tableId: table.tableId || p.tableId, range: newRange },
            fields: 'range',
          },
        },
      ]);

      // Re-fetch updated table
      const updated = await resolveTableIdentifier(token, p.spreadsheetId, (table.tableId as string) || p.tableId);
      return {
        success: true,
        data: {
          tableId: updated.table.tableId,
          name: updated.table.name,
          newRange: p.range,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const appendTableRows = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    tableId: Type.String({ description: 'Table ID' }),
    values: Type.Array(Type.Array(cellValue), { description: '2D array of row values' }),
  }),
)({
  id: 'sheets.append_table_rows',
  name: 'Append Table Rows',
  description: 'Append rows to the end of a table using table-aware insertion.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
      const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;

      if (!tRange) {
        return { success: false, error: 'Table does not have a range defined' };
      }

      const startRow = tRange.endRowIndex || 0;
      const startCol = tRange.startColumnIndex || 0;
      const endCol = tRange.endColumnIndex || 0;
      const range = `${sheetName}!${rowColToA1(startRow, startCol)}:${rowColToA1(startRow + p.values.length - 1, endCol - 1)}`;

      const data = await appendValues(token, p.spreadsheetId, range, p.values);

      // Auto-expand table range to include the newly appended rows
      const tableIdStr = (table.tableId as string) || p.tableId;
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName || undefined);
      const newEndRow = (tRange.endRowIndex || 0) + p.values.length;
      try {
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            updateTable: {
              table: {
                tableId: tableIdStr,
                range: {
                  sheetId,
                  startRowIndex: tRange.startRowIndex || 0,
                  startColumnIndex: tRange.startColumnIndex || 0,
                  endRowIndex: newEndRow,
                  endColumnIndex: tRange.endColumnIndex || 0,
                },
              },
              fields: 'range',
            },
          },
        ]);
      } catch {
        // Table range expansion is best-effort — data is already written
      }

      return {
        success: true,
        data: {
          tableId: table.tableId,
          name: table.name,
          rowsAppended: p.values.length,
          updatedRange: (data as { updates?: { updatedRange?: string } }).updates?.updatedRange || range,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// -- Advanced (9) ------------------------------------------------------------

const groupRows = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
    startRow: Type.Integer({ minimum: 1, description: 'Start row (1-based)' }),
    endRow: Type.Integer({ minimum: 1, description: 'End row (1-based, inclusive)' }),
  }),
)({
  id: 'sheets.group_rows',
  name: 'Group Rows',
  description: 'Create collapsible row groups.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          addDimensionGroup: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: p.startRow - 1,
              endIndex: p.endRow,
            },
          },
        },
      ]);
      return { success: true, data: { rows: `${p.startRow}:${p.endRow}` } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const ungroupAllRows = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
  }),
)({
  id: 'sheets.ungroup_all_rows',
  name: 'Ungroup All Rows',
  description: 'Remove all row groupings from a sheet.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      let removed = 0;

      // deleteDimensionGroup removes one level at a time; loop until no groups remain
      for (;;) {
        try {
          await sheetsBatchUpdate(token, p.spreadsheetId, [
            {
              deleteDimensionGroup: {
                range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 500 },
              },
            },
          ]);
          removed++;
        } catch {
          break;
        }
      }

      return { success: true, data: { levelsRemoved: removed } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const insertChart = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
    chartType: Type.Union(
      [
        Type.Literal('BAR'),
        Type.Literal('LINE'),
        Type.Literal('AREA'),
        Type.Literal('COLUMN'),
        Type.Literal('SCATTER'),
        Type.Literal('COMBO'),
        Type.Literal('PIE'),
      ],
      { description: 'Chart type' },
    ),
    sourceRange: Type.String({ description: 'A1 notation data range' }),
    title: Type.Optional(Type.String({ description: 'Chart title' })),
    position: Type.Optional(
      Type.Object({
        anchorCell: Type.Optional(
          Type.String({ description: 'A1 notation anchor cell for chart placement (e.g. "A15")' }),
        ),
        rowIndex: Type.Optional(
          Type.Integer({ minimum: 0, description: '0-based row index for chart placement (alternative to anchorCell)' }),
        ),
        columnIndex: Type.Optional(
          Type.Integer({ minimum: 0, description: '0-based column index for chart placement (alternative to anchorCell)' }),
        ),
      }),
    ),
  }),
)({
  id: 'sheets.insert_chart',
  name: 'Insert Chart',
  description: 'Insert a chart into a Google Sheet. Supports bar, column, line, area, scatter, combo, and pie chart types.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);

      // Support comma-separated ranges (e.g. "Sheet1!A1:A13,Sheet1!G1:G13")
      const rangeParts = p.sourceRange.split(',').map((r: string) => r.trim());
      const gridRanges = rangeParts.map((part: string) => {
        const { a1Range: a1 } = parseRange(part);
        return parseA1ToGridRange(a1, sheetId);
      });

      // Use the first range for dimension calculations; multi-range uses explicit sources
      const gridRange = gridRanges[0];
      const startRow = gridRange.startRowIndex ?? 0;
      const endRow = gridRange.endRowIndex ?? startRow + 1;
      const startCol = gridRange.startColumnIndex ?? 0;
      const endCol = gridRange.endColumnIndex ?? startCol + 1;

      const colCount = endCol - startCol;
      let chartSpec: Record<string, unknown> = {};

      if (p.chartType === 'PIE') {
        if (colCount < 2) {
          return {
            success: false,
            error: `PIE chart requires at least 2 columns (labels + numeric values), but the source range "${p.sourceRange}" has only ${colCount} column(s). Provide a range like "Sheet!A1:B10" where the first column has labels and the second has numeric values.`,
          };
        }
        chartSpec.pieChart = {
          legendPosition: 'LABELED_LEGEND',
          domain: {
            sourceRange: {
              sources: [{ sheetId, startRowIndex: startRow + 1, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: startCol + 1 }],
            },
          },
          series: {
            sourceRange: {
              sources: [{ sheetId, startRowIndex: startRow + 1, endRowIndex: endRow, startColumnIndex: startCol + 1, endColumnIndex: startCol + 2 }],
            },
          },
        };
      } else if (gridRanges.length > 1) {
        // Multi-range mode: first range = domain (labels), rest = series
        const domainRange = gridRanges[0];
        const seriesEntries = gridRanges.slice(1).map((gr: { startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }) => ({
          series: {
            sourceRange: {
              sources: [{
                sheetId,
                startRowIndex: gr.startRowIndex ?? 0,
                endRowIndex: gr.endRowIndex ?? (gr.startRowIndex ?? 0) + 1,
                startColumnIndex: gr.startColumnIndex ?? 0,
                endColumnIndex: gr.endColumnIndex ?? (gr.startColumnIndex ?? 0) + 1,
              }],
            },
          },
          targetAxis: 'LEFT_AXIS',
        }));

        chartSpec.basicChart = {
          chartType: p.chartType,
          legendPosition: 'BOTTOM_LEGEND',
          axis: [
            { position: 'BOTTOM_AXIS', title: '' },
            { position: 'LEFT_AXIS', title: '' },
          ],
          domains: [{
            domain: {
              sourceRange: {
                sources: [{
                  sheetId,
                  startRowIndex: domainRange.startRowIndex ?? 0,
                  endRowIndex: domainRange.endRowIndex ?? (domainRange.startRowIndex ?? 0) + 1,
                  startColumnIndex: domainRange.startColumnIndex ?? 0,
                  endColumnIndex: domainRange.endColumnIndex ?? (domainRange.startColumnIndex ?? 0) + 1,
                }],
              },
            },
            reversed: false,
          }],
          series: seriesEntries,
          headerCount: 1,
        };
      } else {
        // Single contiguous range: first column = domain, rest = series
        const seriesCount = endCol - startCol - 1;
        // BAR charts are horizontal — series values go on BOTTOM_AXIS, not LEFT_AXIS
        const seriesAxis = p.chartType === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
        const series = Array.from({ length: seriesCount }, (_, i) => ({
          series: {
            sourceRange: {
              sources: [{
                sheetId,
                startRowIndex: startRow,
                endRowIndex: endRow,
                startColumnIndex: startCol + 1 + i,
                endColumnIndex: startCol + 2 + i,
              }],
            },
          },
          targetAxis: seriesAxis,
          // COMBO charts need per-series type — default first series to COLUMN, rest to LINE
          ...(p.chartType === 'COMBO' ? { type: i === 0 ? 'COLUMN' : 'LINE' } : {}),
        }));

        chartSpec.basicChart = {
          chartType: p.chartType,
          legendPosition: 'BOTTOM_LEGEND',
          axis: [
            { position: 'BOTTOM_AXIS', title: '' },
            { position: 'LEFT_AXIS', title: '' },
          ],
          domains: [{
            domain: {
              sourceRange: {
                sources: [{
                  sheetId,
                  startRowIndex: startRow,
                  endRowIndex: endRow,
                  startColumnIndex: startCol,
                  endColumnIndex: startCol + 1,
                }],
              },
            },
            reversed: false,
          }],
          series,
          headerCount: 1,
        };
      }

      if (p.title) chartSpec.title = p.title;

      // Determine anchor position — prefer anchorCell, fall back to rowIndex/columnIndex
      let anchorRow = 0;
      let anchorCol = endCol;
      if (p.position?.anchorCell) {
        const m = p.position.anchorCell.match(/^([A-Z]+)(\d+)$/i);
        if (m) {
          anchorRow = parseInt(m[2], 10) - 1;
          anchorCol = colLettersToIndex(m[1]);
        }
      } else if (p.position?.rowIndex !== undefined || p.position?.columnIndex !== undefined) {
        anchorRow = p.position.rowIndex ?? 0;
        anchorCol = p.position.columnIndex ?? 0;
      }

      const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
        {
          addChart: {
            chart: {
              spec: chartSpec,
              position: {
                overlayPosition: {
                  anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol },
                  widthPixels: 600,
                  heightPixels: 400,
                },
              },
            },
          },
        },
      ]);

      const replies = (data as { replies?: Array<{ addChart?: { chart?: { chartId?: number } } }> }).replies;
      const chartId = replies?.[0]?.addChart?.chart?.chartId;
      return { success: true, data: { chartId } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteChart = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    chartId: Type.Integer({ description: 'Chart ID (from get_spreadsheet_info)' }),
  }),
)({
  id: 'sheets.delete_chart',
  name: 'Delete Chart',
  description: 'Delete a chart from a spreadsheet by its chart ID.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        { deleteEmbeddedObject: { objectId: p.chartId } },
      ]);
      return { success: true, data: { chartId: p.chartId, deleted: true } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const addConditionalFormatting = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
    conditionType: Type.String({ description: 'Condition type (e.g. NUMBER_GREATER, TEXT_CONTAINS, CUSTOM_FORMULA, BLANK, NOT_BLANK)' }),
    conditionValues: Type.Array(Type.String(), { description: 'Condition values' }),
    format: Type.Object(
      {
        backgroundColor: Type.Optional(colorInput),
        bold: Type.Optional(Type.Boolean()),
        italic: Type.Optional(Type.Boolean()),
        textFormat: Type.Optional(
          Type.Object({
            foregroundColor: Type.Optional(colorInput),
            bold: Type.Optional(Type.Boolean()),
            italic: Type.Optional(Type.Boolean()),
          }),
        ),
      },
      { description: 'Format to apply when condition is met' },
    ),
  }),
)({
  id: 'sheets.add_conditional_formatting',
  name: 'Add Conditional Formatting',
  description: 'Add a conditional formatting rule to one or more ranges. Use CUSTOM_FORMULA for complex conditions.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { sheetName, a1Range } = parseRange(p.range);
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);
      const gridRanges = [parseA1ToGridRange(a1Range, sheetId)];

      const conditionValues = p.conditionValues.map((v: string) => ({ userEnteredValue: v }));
      const format: Record<string, unknown> = {};
      if (p.format.backgroundColor) {
        const bg = normalizeColor(p.format.backgroundColor);
        if (bg) format.backgroundColor = bg;
      }

      // Merge top-level bold/italic into textFormat (same pattern as format_cells)
      const mergedTF = { ...p.format.textFormat };
      if ((p.format as Record<string, unknown>).bold !== undefined && mergedTF.bold === undefined) {
        mergedTF.bold = (p.format as Record<string, unknown>).bold as boolean;
      }
      if ((p.format as Record<string, unknown>).italic !== undefined && mergedTF.italic === undefined) {
        mergedTF.italic = (p.format as Record<string, unknown>).italic as boolean;
      }
      const hasTF = mergedTF.foregroundColor !== undefined || mergedTF.bold !== undefined || mergedTF.italic !== undefined;

      if (hasTF) {
        const tf: Record<string, unknown> = {};
        if (mergedTF.foregroundColor) {
          const fg = normalizeColor(mergedTF.foregroundColor);
          if (fg) tf.foregroundColor = fg;
        }
        if (mergedTF.bold !== undefined) tf.bold = mergedTF.bold;
        if (mergedTF.italic !== undefined) tf.italic = mergedTF.italic;
        if (Object.keys(tf).length > 0) format.textFormat = tf;
      }

      await addConditionalFormatRule(
        token,
        p.spreadsheetId,
        gridRanges,
        p.conditionType,
        conditionValues,
        format,
      );
      return { success: true, data: { range: p.range } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteConditionalFormatting = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetId: Type.Integer({ description: 'Sheet ID' }),
    index: Type.Integer({ minimum: 0, description: 'Rule index (0-based, from get_conditional_formatting)' }),
  }),
)({
  id: 'sheets.delete_conditional_formatting',
  name: 'Delete Conditional Formatting',
  description: 'Delete a conditional formatting rule by its index.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await sheetsBatchUpdate(token, p.spreadsheetId, [
        { deleteConditionalFormatRule: { sheetId: p.sheetId, index: p.index } },
      ]);
      return { success: true, data: { sheetId: p.sheetId, index: p.index, deleted: true } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const getConditionalFormatting = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    sheetName: Type.Optional(Type.String({ description: 'Sheet name' })),
  }),
)({
  id: 'sheets.get_conditional_formatting',
  name: 'Get Conditional Formatting',
  description: 'List all conditional formatting rules for a sheet.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
      const qs = new URLSearchParams({
        fields: 'sheets(properties(sheetId,title),conditionalFormats)',
      });
      const res = await sheetsFetch(`/${encodeURIComponent(p.spreadsheetId)}?${qs}`, token);
      if (!res.ok) return sheetsError(res);

      const apiData = await res.json() as {
        sheets?: Array<{
          properties?: { sheetId?: number; title?: string };
          conditionalFormats?: Array<{
            booleanRule?: {
              condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> };
              format?: Record<string, unknown>;
            };
            gradientRule?: unknown;
            ranges?: Array<{
              startColumnIndex?: number;
              endColumnIndex?: number;
              startRowIndex?: number;
              endRowIndex?: number;
            }>;
          }>;
        }>;
      };

      const sheet = apiData.sheets?.find((s) => s.properties?.sheetId === sheetId);
      const rules = sheet?.conditionalFormats ?? [];

      const ruleSummaries = rules.map((rule, idx) => {
        const condition = rule.booleanRule?.condition;
        const fmt = rule.booleanRule?.format ?? {};

        const ranges = (rule.ranges ?? []).map((r) => {
          const sc = r.startColumnIndex != null ? colIndexToLetters(r.startColumnIndex) : '';
          const ec = r.endColumnIndex != null ? colIndexToLetters(r.endColumnIndex - 1) : '';
          const sr = r.startRowIndex != null ? r.startRowIndex + 1 : '';
          const er = r.endRowIndex != null ? r.endRowIndex : '';
          return `${sc}${sr}:${ec}${er}`;
        });

        return {
          index: idx,
          kind: rule.gradientRule ? 'GRADIENT' : 'BOOLEAN',
          ranges,
          conditionType: condition?.type ?? null,
          conditionValues: (condition?.values ?? [])
            .map((v) => v.userEnteredValue)
            .filter((v): v is string => typeof v === 'string'),
          backgroundColor: (fmt as Record<string, unknown>).backgroundColor
            ? rgbToHex((fmt as Record<string, unknown>).backgroundColor as Record<string, number>)
            : null,
          textColor: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.foregroundColor
            ? rgbToHex(((fmt as Record<string, unknown>).textFormat as Record<string, unknown>).foregroundColor as Record<string, number>)
            : null,
          bold: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.bold ?? false,
          italic: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.italic ?? false,
        };
      });

      return {
        success: true,
        data: {
          sheetName: sheet?.properties?.title ?? null,
          count: ruleSummaries.length,
          rules: ruleSummaries,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const setDropdownValidationDef = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range' }),
    values: Type.Optional(Type.Array(Type.String(), { description: 'Dropdown values (omit to clear)' })),
    strict: Type.Optional(Type.Boolean({ description: 'Reject invalid input (default: true)' })),
    inputMessage: Type.Optional(Type.String({ description: 'Help text shown on cell selection' })),
  }),
)({
  id: 'sheets.set_dropdown_validation',
  name: 'Set Dropdown Validation',
  description: 'Add or remove a dropdown list on a range of cells.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      await setDropdownValidation(
        token,
        p.spreadsheetId,
        p.range,
        p.values,
        p.strict ?? true,
        p.inputMessage,
      );
      const isClearing = !p.values || p.values.length === 0;
      return {
        success: true,
        data: {
          range: p.range,
          action: isClearing ? 'cleared' : 'set',
          ...(p.values ? { optionCount: p.values.length } : {}),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const protectRange = action(
  Type.Object({
    spreadsheetId: Type.String({ description: 'Spreadsheet ID' }),
    range: Type.String({ description: 'A1 notation range to protect' }),
    description: Type.Optional(Type.String({ description: 'Protection description' })),
    warningOnly: Type.Optional(Type.Boolean({ description: 'Show warning instead of blocking (default: false)' })),
  }),
)({
  id: 'sheets.protect_range',
  name: 'Protect Range',
  description: 'Lock a range or entire sheet to prevent accidental edits.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { sheetName, a1Range } = parseRange(p.range);
      const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);

      const protectedRangeObj: Record<string, unknown> = {
        description: p.description ?? '',
        warningOnly: p.warningOnly ?? false,
        range: parseA1ToGridRange(a1Range, sheetId),
      };

      const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
        { addProtectedRange: { protectedRange: protectedRangeObj } },
      ]);

      const replies = (data as { replies?: Array<{ addProtectedRange?: { protectedRange?: { protectedRangeId?: number } } }> }).replies;
      const protectionId = replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;

      return {
        success: true,
        data: {
          protectedRangeId: protectionId,
          range: p.range,
          warningOnly: p.warningOnly ?? false,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── Export ──────────────────────────────────────────────────────────────────

export const sheetsActions: PluginAction[] = [
  // Core data
  readSpreadsheet,
  writeSpreadsheet,
  appendRowsDef,
  createSpreadsheet,
  getSpreadsheetInfo,
  listSpreadsheets,
  batchWrite,
  clearRangeDef,
  // Sheet management
  addSheet,
  deleteSheet,
  renameSheet,
  duplicateSheet,
  copySheetTo,
  // Cell formatting
  formatCellsDef,
  readCellFormat,
  copyFormatting,
  setColumnWidthsDef,
  setRowHeights,
  autoResizeColumns,
  autoResizeRows,
  setCellBorders,
  freezeRowsAndColumnsDef,
  // Tables
  createTable,
  getTable,
  listTablesDef,
  deleteTable,
  updateTableRange,
  appendTableRows,
  // Advanced
  groupRows,
  ungroupAllRows,
  insertChart,
  deleteChart,
  addConditionalFormatting,
  deleteConditionalFormatting,
  getConditionalFormatting,
  setDropdownValidationDef,
  protectRange,
];
