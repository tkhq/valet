/**
 * Pure half of workflow import: file text in, a definition and a preview
 * out. No React, so the shapes it accepts and the messages it refuses with
 * are tested directly.
 *
 * One parser reads both sources the import dialog offers — a pasted or
 * uploaded file, and a file read out of a public repository through
 * `GET /api/workflows/import/repo-file`. A second parser for the second
 * source would drift into accepting a shape the first one rejects.
 */
import {
  isWorkflowDefinitionShape,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "~/components/workflows/editor-model";

/**
 * Refuse a file bigger than this before reading it. `JSON.parse` of a
 * multi-megabyte string blocks the main thread, and no workflow definition
 * is anywhere near this size.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface WorkflowImport {
  /** The name the file carried, when it carried one. */
  name?: string;
  definition: WorkflowDefinition;
}

export type ParsedWorkflowImport =
  | { ok: true; value: WorkflowImport }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * File text → a definition to import.
 *
 * Two shapes are accepted, and both already have a producer:
 *   1. A bare definition — what the editor's JSON view shows.
 *   2. `{ name, definition }` — what `GET /api/workflows/:id` answers with,
 *      so a saved API response imports as it stands, with its name.
 *
 * A failure returns the messages to show. When the shape is right but the
 * graph is wrong, those messages are the validator's own, unaltered: they
 * name the node and the field to correct, and a summary in their place
 * leaves the author with nothing to act on.
 *
 * The browser has no plugin catalog, so this cannot know which services the
 * deployment has. `POST /api/workflows` runs the same validator WITH that
 * knowledge and refuses an unknown service there. A definition that passes
 * here can still be refused at create, which is why the dialog shows the
 * server's messages too.
 */
export function parseWorkflowImport(text: string): ParsedWorkflowImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      errors: ["That file is not JSON. Choose an exported workflow definition (.json)."],
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: ["A workflow file holds a JSON object. Choose an exported workflow definition."],
    };
  }

  const envelope = isRecord(raw.definition) ? raw.definition : undefined;
  const candidate: unknown = envelope ?? raw;
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;

  if (!isWorkflowDefinitionShape(candidate)) {
    return {
      ok: false,
      errors: [
        'That file holds no workflow definition. A definition carries "version", "nodes" and "edges" — export one from a workflow, or copy it from the editor\'s JSON view.',
      ],
    };
  }

  const result = validateWorkflowDefinition(candidate);
  if (!result.ok) return { ok: false, errors: result.errors };

  return { ok: true, value: name === undefined ? { definition: candidate } : { name, definition: candidate } };
}

export interface ImportPreview {
  nodeCount: number;
  /** Node types with how many of each, most frequent first. */
  nodeTypes: { type: string; count: number }[];
  /** Every service the definition calls a tool on, in first-seen order. */
  services: string[];
}

/** What the definition contains, for the step the user reads before they
 * commit. A foreach body is a node the run executes, so its service counts
 * the same as a top-level one. */
export function previewWorkflowImport(definition: WorkflowDefinition): ImportPreview {
  const counts = new Map<string, number>();
  const services: string[] = [];

  for (const node of definition.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    const service =
      node.type === "tool"
        ? node.service
        : node.type === "foreach" && node.body.type === "tool"
          ? node.body.service
          : undefined;
    if (service !== undefined && service !== "" && !services.includes(service)) services.push(service);
  }

  return {
    nodeCount: definition.nodes.length,
    nodeTypes: [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    services,
  };
}

/**
 * The name to offer when the file carried none. A file name is the closest
 * thing to one an author chose, so `workflows/nightly-deploy.json` becomes
 * "nightly-deploy". Pasted text has no file name and falls back.
 */
export function suggestedImportName(fileName: string | undefined): string {
  const base = (fileName ?? "").split("/").pop() ?? "";
  const withoutExtension = base.replace(/\.json$/i, "").trim();
  return withoutExtension === "" ? "Imported workflow" : withoutExtension;
}
