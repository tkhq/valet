/**
 * Pure half of workflow import: file text in, a definition and a preview
 * out. No React, so the shapes it accepts and the messages it refuses with
 * are tested directly.
 *
 * One parser reads every source the product offers — a pasted or uploaded
 * file, a file read out of a public repository through
 * `GET /api/workflows/import/repo-file`, and a file the repository sync
 * mirrors. That parser is `parseWorkflowFileValue` in `@valet/workflow`, so
 * the browser and the server cannot drift into accepting different shapes.
 * This module supplies the decoder and nothing else.
 *
 * ## The decoder
 *
 * `JSON.parse` runs first, because every file the editor exports and every
 * API response is JSON. Only when that throws does a YAML chunk load, and
 * `import("yaml")` keeps it out of the main bundle: a person who never
 * imports a YAML workflow never downloads the parser. YAML 1.2 is a superset
 * of JSON, so the fallback would also read the JSON — trying JSON first is
 * what keeps the common path synchronous in everything but its signature.
 */
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type WorkflowDefinition,
} from "@valet/workflow";

/**
 * Refuse a file bigger than this before reading it. Parsing a multi-megabyte
 * string blocks the main thread, and no workflow definition is anywhere near
 * this size.
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

/**
 * File text → a definition to import.
 *
 * Three shapes are accepted, and each already has a producer:
 *   1. The `valet: workflow/v1` envelope — what the repository sync reads and
 *      what export writes.
 *   2. A bare definition — what the editor's JSON view shows.
 *   3. `{ name, definition }` — what `GET /api/workflows/:id` answers with,
 *      so a saved API response imports as it stands, with its name.
 *
 * A `valet: workflow-template/v1` file imports as the workflow its graph
 * describes, under the template's name. Installing a template produces a
 * local workflow too, so the two paths agree.
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
export async function parseWorkflowImport(
  text: string,
  fileName?: string,
): Promise<ParsedWorkflowImport> {
  const label = fileName === undefined || fileName.trim() === "" ? "The pasted text" : fileName;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    try {
      const { parse } = await import("yaml");
      raw = parse(text);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `${label} is neither JSON nor YAML: ${err instanceof Error ? err.message : String(err)}. Choose an exported workflow file.`,
        ],
      };
    }
  }

  const parsed = parseWorkflowFileValue(raw, label);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const name = parsed.file.kind === "template" ? parsed.file.template.name : parsed.file.name;
  return {
    ok: true,
    value:
      name === undefined
        ? { definition: parsed.file.definition }
        : { name, definition: parsed.file.definition },
  };
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
 * thing to one an author chose, so `workflows/nightly-deploy.yaml` becomes
 * "nightly-deploy". Pasted text has no file name and falls back.
 */
export function suggestedImportName(fileName: string | undefined): string {
  const base = (fileName ?? "").split("/").pop() ?? "";
  const extension = WORKFLOW_FILE_EXTENSIONS.find((suffix) =>
    base.toLowerCase().endsWith(suffix),
  );
  const withoutExtension = (
    extension === undefined ? base : base.slice(0, -extension.length)
  ).trim();
  return withoutExtension === "" ? "Imported workflow" : withoutExtension;
}
