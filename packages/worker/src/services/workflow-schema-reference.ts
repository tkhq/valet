/**
 * Authoritative dag/v1 schema reference.
 *
 * Returns a compact, model-readable description of every valid node
 * type, edge fields, condition operations, template syntax, and id
 * rules. Used by:
 *   • the workflow copilot (system prompt + getNodeSchema tool)
 *   • the workflows.schema orchestrator action
 *
 * Pure / sync / no DB lookups — safe to inline into a prompt.
 */
import { allowedIfOperations } from '../lib/workflow-dag/if-operations.js';
import {
  FOREACH_BODY_NODE_TYPES,
  LEGACY_NODE_TYPE_ALIASES,
  LEGACY_NODE_TYPE_NOTES,
  WORKFLOW_NODE_TYPES,
} from '../lib/workflow-dag/schema.js';

export function getWorkflowSchemaReference() {
  return {
    version: 'dag/v1',
    validNodeTypes: WORKFLOW_NODE_TYPES,
    foreachBodyTypes: FOREACH_BODY_NODE_TYPES,
    legacyNodeTypeAliases: LEGACY_NODE_TYPE_ALIASES,
    removedNodeTypeNotes: LEGACY_NODE_TYPE_NOTES,
    idSyntax: {
      allowedPattern: '^[A-Za-z0-9_-]+$',
      maxLength: 80,
      note: 'Dot notation only works for identifier-safe node IDs. For IDs containing "-", use bracket notation such as {{nodes["tool-1"].data.result}}.',
    },
    templates: {
      delimiters: '{{ expression }}',
      runtimeContext: ['trigger', 'nodes', 'item', 'index'],
      examples: [
        '{{trigger.data}}',
        '{{trigger.data.name}}',
        '{{nodes.prepare.data.message}}',
        '{{nodes["tool-1"].data.issues}}',
        '{{item.title}}',
      ],
      note: 'Use nodes.*, not outputs.*.',
    },
    edges: {
      fields: ['from', 'to', 'fromOutput', 'when'],
      ifBranches: ['true', 'false'],
      note: 'Edges connect top-level node IDs only. Edges from if nodes must set fromOutput to "true" or "false".',
    },
    // Every medium/high-risk tool node raises a human approval gate
    // before it executes. Not obvious to authors — flag it inline so
    // scale planning happens before build time.
    approvals: {
      rule: 'Every tool node with riskLevel medium or high raises ONE human approval per invocation. For a foreach whose body is a tool node, the first iteration prompts; the run detail UI then offers "Approve remaining rows" to batch-clear the rest of the loop.',
      lowRiskAutoRuns: 'Tool nodes with riskLevel `low` (queries, reads, list operations) do NOT gate — they execute directly.',
      unattended: 'Scheduled/unattended runs stall on any pending approval. Prefer low-risk read tools inside foreach bodies when the workflow is intended to run unattended.',
    },
    conditionOperations: {
      string: allowedIfOperations('string'),
      number: allowedIfOperations('number'),
      date: allowedIfOperations('date'),
      boolean: allowedIfOperations('boolean'),
      array: allowedIfOperations('array'),
      object: allowedIfOperations('object'),
      aliases: {
        is_not_empty: 'isNotEmpty',
        is_empty: 'isEmpty',
        not_equals: 'notEquals',
        does_not_exist: 'doesNotExist',
        does_not_contain: 'doesNotContain',
        starts_with: 'startsWith',
        ends_with: 'endsWith',
        matches_regex: 'matchesRegex',
        greater_than: 'greaterThan',
        less_than: 'lessThan',
        greater_than_or_equal: 'greaterThanOrEqual',
        less_than_or_equal: 'lessThanOrEqual',
        is_true: 'isTrue',
        is_false: 'isFalse',
      },
    },
    nodes: [
      {
        type: 'trigger',
        required: ['id', 'type'],
        optional: ['dataSchema'],
        description: 'Represents the invocation source and exposes trigger.data, trigger.metadata, trigger.type, and trigger.timestamp.',
        dataSchema: {
          shape: 'Record<fieldName, { type, required?, default?, description?, enum? }>',
          fieldTypes: ['string', 'number', 'boolean', 'object', 'array'],
          fieldOptions: {
            type: 'One of the field types above. Required.',
            required: 'boolean. Manual runs reject empty inputs when true.',
            default: 'Any JSON value matching `type`. Pre-fills the manual test-run form AND is applied at runtime when the trigger payload omits the field. STRONGLY RECOMMENDED for every field: it makes the workflow testable in one click and lets webhook/schedule triggers omit rarely-changing values.',
            description: 'Short human-facing help text shown in the manual run form.',
            enum: 'Optional array of allowed values. Runtime rejects payloads whose value is not in the list.',
          },
          example: {
            names: { type: 'array', required: true, default: ['Alice', 'Bob', 'Carol'], description: 'Recipients for this campaign.' },
            budget: { type: 'number', default: 5000, description: 'Total spend cap in USD.' },
            campaignTitle: { type: 'string', required: true, default: 'Q3 Campaign' },
          },
        },
      },
      {
        type: 'llm',
        required: ['id', 'type', 'prompt'],
        optional: ['model', 'system', 'outputSchema', 'temperature', 'maxOutputTokens'],
        description: 'Generate text or structured output. Model IDs use provider:model.',
      },
      {
        type: 'tool',
        required: ['id', 'type', 'service', 'action', 'params'],
        optional: ['summary', 'onPolicyDeny', 'retries', 'outputSchema'],
        description: 'Call a remote integration action. Optionally declare `outputSchema` when the action returns a shape the tool package can\'t know statically (arbitrary-query tools like SOQL, raw SQL, HTTP fetch) — the per-node schema then feeds foreach typed-array derivation without needing an intermediate `set`/`llm` reshape node.',
        outputSchemaExample: {
          purpose: 'Make `{{nodes.query.data.records}}` a legal `foreach.items` source when the tool package doesn\'t register a static output schema.',
          shape: '{ type: "object", properties: { records: { type: "array", items: { type: "object" } }, totalSize: { type: "number" } }, required: ["records"] }',
        },
        actionIdFormat: {
          rule: 'Use the actionId exactly as it appears after the first colon in the tool id returned by `list_tools`. Do not strip prefixes, do not guess.',
          examples: {
            'salesforce-read-only:salesforce-read-only.soqlQuery': {
              service: 'salesforce-read-only',
              action: 'salesforce-read-only.soqlQuery',
              note: 'Salesforce MCP actions are service-prefixed — the prefix is part of the action id.',
            },
            'google_workspace:sheets.write_spreadsheet': {
              service: 'google_workspace',
              action: 'sheets.write_spreadsheet',
              note: 'Google Workspace actions are NOT service-prefixed.',
            },
          },
          verify: 'workflows.save_draft (with validate=true) and workflows.validate check both. `unknown_tool_action` (typo on a KNOWN service) is a hard error with a nearest-match suggestion — a clean save proves the action id resolves. `unknown_tool_service` is a WARNING, not a hard block, because the catalog may not see per-user custom MCP connectors; check the warnings list to catch it.',
        },
      },
      {
        type: 'set',
        required: ['id', 'type', 'values'],
        optional: ['outputSchema'],
        description: 'Write structured values to nodes.<id>.data. Optionally declare an outputSchema so array-typed fields inside `values` (including template-reference fields) count as valid foreach sources — the deterministic alternative to using an LLM node just to `.map()` an upstream result.',
        outputSchemaExample: {
          purpose: 'Make {{nodes.extract.data.records}} a legal `foreach.items` source when `values.records` is a template reference (not a literal array).',
          shape: '{ type: "object", properties: { records: { type: "array", items: { type: "object" } } }, required: ["records"] }',
        },
      },
      {
        type: 'if',
        required: ['id', 'type', 'conditions'],
        optional: ['combinator'],
        description: 'Branch on conditions. Conditions use left, dataType, operation, and optional right. NOT to be confused with "condition" — the node type is literally `if`.',
      },
      {
        type: 'wait',
        required: ['id', 'type', 'mode', 'duration'],
        optional: [],
        description: 'Sleep for a duration. MVP mode is "duration".',
      },
      {
        type: 'approval',
        required: ['id', 'type', 'prompt'],
        optional: ['summary', 'details', 'timeout', 'onDeny'],
        description: 'Pause until a human approves or denies. `prompt` is the human-facing question — it is REQUIRED; do not put it in `summary`.',
      },
      {
        type: 'foreach',
        required: ['id', 'type', 'items', 'body'],
        optional: ['itemAlias', 'indexAlias', 'maxItems', 'concurrency', 'onItemError'],
        description: 'Iterate over an array expression and run one allowed body node per item. Optional maxItems truncates the input array before execution.',
        constraints: {
          bodyTypes: FOREACH_BODY_NODE_TYPES,
          bodyNote: 'Nested if, wait, approval, trigger, and foreach nodes are not supported in foreach body.',
        },
        // `items` must be a "provably-typed array" — the source node's
        // shape must declare or produce an array at the referenced
        // path. This is the single most common friction point when
        // authoring data-processing workflows; the table below is the
        // full valid-source enumeration.
        itemsSources: {
          rule: 'The referenced path must be provably an array; templates that could resolve to any shape are rejected with `foreach_items_untyped_array_output`.',
          patterns: [
            { source: 'trigger', template: '{{trigger.data.<field>}}', precondition: 'trigger.dataSchema.<field>.type === "array"' },
            { source: 'llm', template: '{{nodes.<id>.data.<field>}} or {{nodes.<id>.data}} if root is array', precondition: 'outputSchema declares field/root as {"type":"array"}' },
            { source: 'set', template: '{{nodes.<id>.data.<field>}}', precondition: 'Either `values` has a literal array at that path, OR `outputSchema` declares that field as {"type":"array"} (the deterministic-reshape path — pair with a template reference under `values`)' },
            { source: 'tool', template: '{{nodes.<id>.data.<field>}}', precondition: 'Either a service-level toolOutputSchema is registered for this service:action declaring the field as array, OR the tool node itself carries `outputSchema` describing the shape (the arbitrary-query path — SOQL/SQL/HTTP fetch). Per-node schema beats registered.' },
            { source: 'orchestrator/session', template: '{{nodes.<id>.data.output.<field>}}', precondition: 'wait.mode === "until_idle" AND outputSchema declares field as array. Note the `.data.output.<field>` nesting — llm/tool go direct at `.data.<field>`.' },
            { source: 'orchestrator/session', template: '{{nodes.<id>.data.transcript}}', precondition: 'resultMode === "transcript"' },
            { source: 'foreach', template: '{{nodes.<id>.data.items}}', precondition: 'Always valid (nested-foreach chaining).' },
            { source: 'project', template: '{{nodes.<id>.data}}', precondition: 'Always valid — a project node\'s output IS the 2D array. Use `.data` at the root, NOT `.data.<field>`.' },
          ],
        },
        // Downstream nodes reading a foreach's output must know the
        // wrapper shape. This is not obvious — I had to read a trace
        // to discover the .data nesting on each item.
        resultShape: {
          shape: '{{nodes.<foreach-id>.data}} = { items: Array<{ status: "completed"|"skipped"|"failed", data: <body node output> }>, count, inputCount, completedCount, skippedCount, failedCount, truncatedCount }',
          itemAccess: 'Inside a downstream foreach iterating over the previous loop\'s output, each `item` has the wrapper shape too — reference `item.data.<field>` (NOT `item.<field>`).',
          example: 'foreach `write_loop` over {{nodes.tier_loop.data.items}} → body params reference `{{item.data.tier}}`, `{{item.data.accountName}}`, etc.',
        },
      },
      {
        type: 'orchestrator',
        required: ['id', 'type', 'prompt'],
        optional: ['forceNewThread', 'wait'],
        description: 'Prompt the user orchestrator.',
      },
      {
        type: 'session',
        required: ['id', 'type', 'mode', 'prompt'],
        optional: ['workspace', 'title', 'personaId', 'model', 'repo', 'sessionId', 'threadId', 'forceNewThread', 'wait'],
        description: 'Start a new session or prompt an existing session. mode is "start" or "prompt".',
      },
      {
        type: 'stop',
        required: ['id', 'type'],
        optional: ['outcome', 'output', 'message'],
        description: 'End a branch with optional output.',
      },
      {
        type: 'project',
        required: ['id', 'type', 'source', 'columns'],
        optional: ['includeHeader'],
        description: 'Deterministic array-of-records → 2D array reshape. Reads `source` (must resolve to an array), then for each element emits an array of cells by resolving each column\'s dotted `path`. Emits `Array<Array<unknown>>` at `nodes.<id>.data`, ready to feed Sheets `write_spreadsheet` / `append_rows` directly. Pure; no LLM cost. Replaces the LLM-as-formatter anti-pattern for query-result → spreadsheet flows.',
        columnShape: '{ header: string, path: string, default?: unknown }',
        example: {
          id: 'rows',
          type: 'project',
          source: '{{nodes.query.data.records}}',
          includeHeader: true,
          columns: [
            { header: 'Account', path: 'Account.Name' },
            { header: 'Funding', path: 'Account.Funding_Raised__c', default: 0 },
            { header: 'Owner', path: 'Owner.Name' },
          ],
        },
        foreachSource: 'A project node\'s output IS the array — use `{{nodes.<id>.data}}` (not `.data.<field>`) as the foreach source.',
      },
    ],
  };
}
