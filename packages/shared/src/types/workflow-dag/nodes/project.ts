import type { NodeDocs } from '../docs.js';

/**
 * A single column projection: resolves a dotted path against each source
 * item and emits the resulting cell. `path` supports the same dotted /
 * bracketed syntax used in template expressions.
 */
export interface ProjectColumn {
  header: string;
  path: string;
  /**
   * Optional default when the path resolves to null/undefined. Emitted
   * verbatim as the cell value. When omitted, missing paths produce an
   * empty string so the cell type stays consistent with the rest.
   */
  default?: unknown;
}

export interface ProjectNode {
  id: string;
  type: 'project';
  /**
   * Template expression that must resolve to an array of records. The
   * usual foreach-source rules apply: use a static array (`set`
   * outputSchema), a tool node with a registered/inline
   * `outputSchema`, an llm outputSchema field, etc.
   */
  source: string;
  columns: ProjectColumn[];
  /**
   * When true (the default), the emitted array starts with a header
   * row of `columns[].header`. Set false to skip — useful when
   * appending rows to a sheet that already has headers.
   */
  includeHeader?: boolean;
}

export function createDefaultProjectNode(id: string): ProjectNode {
  return { id, type: 'project', source: '', columns: [] };
}

export const projectNodeDocs: NodeDocs<ProjectNode> = {
  label: 'Project',
  description: 'Reshape an array of records into a 2D array (rows of cells)',
  longDescription: `Deterministic array→2D transform. Reads \`source\` (which must resolve to
an array of objects), then for each element emits an array of cell values
by resolving the \`path\` of each column against that element. The result
lands under \`nodes.<id>.data\` as \`Array<Array<unknown>>\`, ready to feed
Sheets \`write_spreadsheet\` / \`append_rows\` or any other tabular sink.

Because it's pure and typed, a \`project\` node is a valid \`foreach.items\`
source and doesn't need an intermediate \`llm\` reshape node.

By default the first row is a header derived from \`columns[].header\`. Set
\`includeHeader: false\` to skip when appending to an already-headed sheet.`,
  fields: {
    source: {
      help: 'Template resolving to Array<record>. Example: {{nodes.query.data.records}}.',
    },
    columns: {
      help: 'Array of { header, path, default? }. `path` is dotted/bracketed against each source record.',
    },
    includeHeader: {
      help: 'Prepend a header row of column headers (default: true).',
    },
  },
};
