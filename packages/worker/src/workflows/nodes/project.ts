/**
 * `project` node executor — deterministic array→2D-array reshape.
 *
 * Reads the `source` template (must resolve to an array of records),
 * then for each record produces an array of cell values by resolving
 * each column's dotted `path` against the record. Emits `Array<Array<unknown>>`
 * under `nodes.<id>.data`, optionally prefixed by a header row.
 *
 * Pure. No side effects, no network calls. Not step-driven — the outer
 * runtime wraps this in its own step.do for replay caching.
 */

import type { ProjectNode } from '@valet/shared';
import { renderTemplate } from '../../lib/workflow-dag/expression.js';
import { buildTemplateContext } from '../context.js';
import type { NodeExecutorArgs } from '../types.js';

export async function executeProject(args: NodeExecutorArgs<ProjectNode>): Promise<unknown[][]> {
  const ctx = buildTemplateContext(args.state, args.aliases);
  const resolved = renderTemplate(args.node.source, ctx);
  if (!Array.isArray(resolved)) {
    throw new Error(
      `project "${args.node.id}": source expression ${JSON.stringify(args.node.source)} did not resolve to an array (got ${describeType(resolved)})`,
    );
  }

  const includeHeader = args.node.includeHeader !== false;
  const rows: unknown[][] = [];
  if (includeHeader) {
    rows.push(args.node.columns.map((col) => col.header));
  }
  for (const record of resolved) {
    rows.push(args.node.columns.map((col) => resolveCell(record, col.path, col.default)));
  }
  return rows;
}

/**
 * Resolve a dotted path against a record. Non-object intermediate segments
 * abort the walk (they can't have children by definition). Own-property
 * only — never walks into `__proto__` / `constructor` / other inherited
 * keys, so an attacker-controlled column path can't leak prototype internals
 * into a spreadsheet cell.
 *
 * Missing / undefined resolves to `fallback` when provided; when `fallback`
 * itself is undefined (author omitted the field), we emit empty string so
 * cell types stay consistent across a row. An explicit `null` fallback is
 * preserved as-is — a user who says `default: null` gets `null`, not `''`.
 */
function resolveCell(record: unknown, path: string, fallback: unknown): unknown {
  const segments = path.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
  let cur: unknown = record;
  for (const seg of segments) {
    if (cur === null || cur === undefined) {
      cur = undefined;
      break;
    }
    if (typeof cur !== 'object') {
      cur = undefined;
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = undefined;
      break;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined || cur === null) {
    // `fallback` is undefined when the author didn't specify one → empty string.
    // Explicit `null` (or any other value) passes through verbatim.
    return fallback === undefined ? '' : fallback;
  }
  return cur;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
