/**
 * Registered output schemas for tool actions with fixed shape.
 *
 * Fed into `WorkflowDefinitionValidationContext.toolOutputSchemas` so
 * the validator's typed-array derivation can accept
 * `{{nodes.<id>.data.<field>}}` as a foreach source without requiring
 * each workflow author to declare the shape inline via a per-node
 * `outputSchema` override. Only registers tools whose top-level shape
 * is invariant across invocations — arbitrary-query tools (raw
 * SOQL/SQL/HTTP) still need the per-node override because their
 * element shape depends on the query string.
 *
 * Format: keys are `service:actionId` (matching `toolOutputSchemaKey`
 * in the validator); values are JSON-schema-shaped objects. Keep
 * schemas minimal — only what's needed to satisfy foreach typed-array
 * derivation and template-reference linting. Don't over-specify
 * per-record element shapes; those DO vary.
 */

export const REGISTERED_TOOL_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  // Salesforce SOQL always returns { totalSize, done, records:[...] }.
  // The record element shape depends on the SELECT clause, so `items`
  // stays permissive; only `records: array` matters for foreach.
  'salesforce-read-only:salesforce-read-only.soqlQuery': {
    type: 'object',
    properties: {
      totalSize: { type: 'number' },
      done: { type: 'boolean' },
      records: { type: 'array', items: { type: 'object' } },
      nextRecordsUrl: { type: 'string' },
    },
    required: ['records'],
  },
  'salesforce-read-only:salesforce-read-only.find': {
    type: 'object',
    properties: {
      searchRecords: { type: 'array', items: { type: 'object' } },
    },
    required: ['searchRecords'],
  },
  'salesforce-read-only:salesforce-read-only.listRecentSobjectRecords': {
    type: 'object',
    properties: {
      recentItems: { type: 'array', items: { type: 'object' } },
    },
    required: ['recentItems'],
  },

  // Google Sheets read → { values: [[...]] }. `values` IS the 2D row
  // array; declaring it as an array makes it a valid foreach source.
  'google_workspace:sheets.read_spreadsheet': {
    type: 'object',
    properties: {
      range: { type: 'string' },
      values: { type: 'array' },
    },
    required: ['values'],
  },
  'google_workspace:drive.list_files': {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'object' } },
      nextPageToken: { type: 'string' },
    },
    required: ['files'],
  },
  'google_workspace:drive.search_files': {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'object' } },
      nextPageToken: { type: 'string' },
    },
    required: ['files'],
  },
  'google_workspace:drive.list_documents': {
    type: 'object',
    properties: {
      documents: { type: 'array', items: { type: 'object' } },
      nextPageToken: { type: 'string' },
    },
    required: ['documents'],
  },
  'google_workspace:drive.list_folder_contents': {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'object' } },
      nextPageToken: { type: 'string' },
    },
    required: ['files'],
  },
  'google_workspace:sheets.list_spreadsheets': {
    type: 'object',
    properties: {
      spreadsheets: { type: 'array', items: { type: 'object' } },
    },
    required: ['spreadsheets'],
  },
  'google_workspace:sheets.list_tables': {
    type: 'object',
    properties: {
      tables: { type: 'array', items: { type: 'object' } },
    },
    required: ['tables'],
  },
};
