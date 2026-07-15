/**
 * Registered output schemas for tool actions with fixed shape.
 *
 * Fed into `WorkflowDefinitionValidationContext.toolOutputSchemas` so
 * the validator's typed-array derivation can accept
 * `{{nodes.<id>.data.<field>}}` as a foreach source without requiring
 * a per-node `outputSchema` override.
 *
 * Scope: **MCP-backed tools only.** First-party plugin actions (Google
 * Workspace, GitHub, etc.) declare `outputSchema` directly on their
 * `ActionDefinition`, and `buildValidatorToolContext` surfaces those
 * via `buildActionCatalog` automatically — so a static duplicate here
 * would only drift out of sync (and, worse, could silently WIN over
 * the plugin schema if a build-time bug ever removed the plugin
 * export). MCP-backed servers like `salesforce-read-only` don't
 * advertise output schemas via the MCP protocol, so their fixed-shape
 * envelopes need a curated home. That's what this file is.
 *
 * Format: keys are `service:actionId` (matching `toolOutputSchemaKey`
 * in the validator); values are JSON-schema-shaped objects. Keep
 * schemas minimal — only what's needed to satisfy foreach typed-array
 * derivation and template-reference linting. Don't over-specify
 * per-record element shapes; those DO vary by query.
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
};
