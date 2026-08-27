/**
 * Pure half of workflow import: file text in, a definition and a preview
 * out. No React, so the shapes it accepts and the messages it refuses with
 * are tested directly.
 *
 * The shapes are `parseWorkflowFileValue`'s in `@valet/workflow`, so the
 * browser and the server cannot drift apart. This module supplies the
 * decoder: `JSON.parse` first, because every exported file and every API
 * response is JSON, then a YAML chunk that `import("yaml")` keeps out of the
 * main bundle for everyone who imports no YAML.
 */
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type WorkflowDefinition,
} from "@valet/workflow";

/** Refuse a file bigger than this before reading it. Parsing a multi-megabyte
 * string blocks the main thread. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface WorkflowImport {
  /** The name the file carried, when it carried one. */
  name?: string;
  definition: WorkflowDefinition;
  /**
   * The envelope blocks this import does NOT create, as short phrases for
   * the review step to print. `POST /api/workflows` writes a name and a
   * definition; a schedule, event triggers and a description have nowhere to
   * land, and dropped in silence they import as a workflow that never runs.
   */
  skipped: string[];
}

export type ParsedWorkflowImport =
  | { ok: true; value: WorkflowImport }
  | { ok: false; errors: string[] };

/**
 * File text → a definition to import. Three shapes parse: the
 * `valet: workflow/v1` envelope, a bare definition (the editor's JSON view),
 * and `{ name, definition }` (what `GET /api/workflows/:id` answers with). A
 * `valet: workflow-template/v1` file imports as the workflow its graph
 * describes, under the template's name.
 *
 * When the shape is right but the graph is wrong, the validator's own
 * messages come back unaltered: they name the node and the field to correct.
 * A file this function cannot decode at all gets a message from here.
 *
 * The browser has no plugin catalog, so a definition that passes here can
 * still be refused by `POST /api/workflows`, which runs the same validator
 * with one.
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
    // A chunk that does not arrive says nothing about the file. One catch
    // for both would send the reader to edit a file that was correct.
    let yaml: typeof import("yaml");
    try {
      yaml = await import("yaml");
    } catch (err) {
      return {
        ok: false,
        errors: [
          `Valet could not load the YAML reader: ${detail(err)}. Reload the page, then try again. A JSON file imports without this reader.`,
        ],
      };
    }
    try {
      raw = yaml.parse(text);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `${label} is neither JSON nor YAML: ${detail(err)}. Choose an exported workflow file.`,
        ],
      };
    }
  }

  const parsed = parseWorkflowFileValue(raw, label);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const file = parsed.file;
  const name = file.kind === "template" ? file.template.name : file.name;
  const description = file.kind === "template" ? file.template.description : file.description;

  const skipped: string[] = [];
  if (file.schedule !== undefined) skipped.push("a schedule");
  if (file.events !== undefined && file.events.length > 0) {
    skipped.push(
      file.events.length === 1 ? "an event trigger" : `${file.events.length} event triggers`,
    );
  }
  if (description !== undefined && description.trim() !== "") skipped.push("a description");

  return {
    ok: true,
    value:
      name === undefined
        ? { definition: file.definition, skipped }
        : { name, definition: file.definition, skipped },
  };
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ImportPreview {
  nodeCount: number;
  /** Node types with how many of each, most frequent first. */
  nodeTypes: { type: string; count: number }[];
  /** Every service the definition calls a tool on, in first-seen order. */
  services: string[];
}

/** What the definition contains, for the step the user reads before they
 * commit. A foreach body is a node the run executes, so its service counts. */
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

/** The name to offer when the file carried none: `nightly-deploy.yaml` becomes
 * "nightly-deploy". Pasted text has no file name and falls back. */
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
