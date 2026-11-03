/**
 * Which repository paths hold workflow definitions, and how content sync
 * reads one. Pure: no database and no plugin catalog, so `valet validate`
 * applies the rules `workflow-collector.ts` applies. Read that file for the
 * two roots and why a subpath does not narrow them.
 */
import { parse as parseYaml, YAMLParseError } from "yaml";
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type ValidateEnvironment,
  type WorkflowFile,
} from "@valet/workflow";

/** The two roots that hold definitions. */
export const WORKFLOW_ROOTS = [".valet/workflows", "workflows"] as const;

/** The root that claims `path`, or null. A file sitting directly in `.valet/`
 * is not under `.valet/workflows` and is never a candidate, which keeps this
 * away from `.valet/prebuild.yaml`. A file without a workflow extension is
 * never a candidate either. */
export function workflowRootFor(path: string): string | null {
  if (!WORKFLOW_FILE_EXTENSIONS.some((ext) => path.endsWith(ext))) return null;
  for (const root of WORKFLOW_ROOTS) {
    if (path.startsWith(`${root}/`) && path.length > root.length + 1) return root;
  }
  return null;
}

/**
 * What sync says about a file it does not mirror. `message` is the one sync
 * warning. `problems` holds the same text one problem per entry, and `line`
 * is the 1-based line of a YAML syntax error, for a caller that reports
 * each problem on its own line.
 */
export interface WorkflowFileWarning {
  kind: "warn";
  message: string;
  problems: string[];
  line?: number;
}

/** One candidate's body to a workflow file, or to what to say about it. */
export function readWorkflowFile(
  raw: string,
  path: string,
  root: string,
  env: ValidateEnvironment | undefined,
): { kind: "ok"; file: WorkflowFile } | WorkflowFileWarning | { kind: "skip" } {
  let value: unknown;
  try {
    // YAML 1.2 parses JSON, so one parser reads both accepted forms.
    value = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    return warn(`${path} is not valid YAML or JSON${detail}. Fix the file and push.`, undefined,
      err instanceof YAMLParseError ? err.linePos?.[0].line : undefined);
  }

  const parsed = parseWorkflowFileValue(value, path, env ?? {});
  if (!parsed.ok) {
    // A file with no `valet:` key under a repository's own `workflows/` is
    // not a mistake: that folder belongs to the repository and may hold
    // anything. Under `.valet/workflows` the folder is unambiguous, so the
    // same file gets a warning naming the path.
    if (parsed.code === "unlabeled" && root !== ".valet/workflows") {
      return { kind: "skip" };
    }
    // The validator names the node and not the file, so the path goes in
    // front of its messages. Without it, the most common failure of this
    // feature reports a broken node and never says which file holds it.
    return warn(`${path}: ${parsed.errors.join(" ")}`, parsed.errors);
  }
  // The two collectors partition the path space by FOLDER, so a template
  // that sits in a workflow folder is mirrored by neither. Say so: silence
  // here reads as "Valet took it" to the person who wrote it. The message
  // names both halves of the fix, because moving the file is not enough on
  // a source that does not collect templates.
  if (parsed.file.kind !== "workflow") {
    return warn(`${path} is a workflow template and it sits in a workflow folder, so Valet did not mirror it. Move it to .valet/templates/ and push, and check that this repository is set to collect templates.`);
  }

  // A YAML anchor that refers to itself survives the validator, which only
  // walks `version`, `policy`, `nodes` and `edges`. It then throws out of
  // `JSON.stringify` in drizzle's jsonb encoder and in
  // `definitionVersionId`, which would abort the sync for every OTHER file
  // in the same pass. One file's mistake must cost that file only.
  try {
    JSON.stringify(parsed.file.definition);
  } catch {
    return warn(`${path}: this workflow refers to itself, so Valet cannot store it. Look for a YAML anchor that includes the node holding it, and write the value out in full.`);
  }
  return { kind: "ok", file: parsed.file };
}

function warn(message: string, problems: string[] = [message], line?: number): WorkflowFileWarning {
  return { kind: "warn", message, problems, ...(line === undefined ? {} : { line }) };
}
