/**
 * `definitionVersionId` (Phase 5 plan decision 17): sha256 of the canonical
 * `JSON.stringify` of a workflow definition, computed at run-start time. The
 * run row snapshots the definition itself, so later edits to the
 * `workflow_definitions` row never affect an in-flight run — this hash is
 * purely an identifying label for "which version was this run started
 * against," not a cache/dedupe key.
 */
import { createHash } from "node:crypto";
import { normalizeLegacyDefinition } from "@valet/workflow";

export function definitionVersionId(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

/** A definition's steps without its map layout (`ui`: node positions, the
 * viewport). Normalized, so an older binary's legacy shape reads the same. */
function stepsOf(definition: unknown): unknown {
  const normalized = normalizeLegacyDefinition(definition);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const { ui: _layout, ...steps } = normalized as Record<string, unknown>;
  return steps;
}

/** JSON with object keys sorted. A definition read back from a jsonb column
 * has its keys reordered, so plain `JSON.stringify` would call it changed. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two definitions hold the same steps. Moving a node on the map, an
 * older binary re-saving a legacy shape, or a jsonb read-back is not a change. */
export function sameWorkflowSteps(a: unknown, b: unknown): boolean {
  return canonical(stepsOf(a)) === canonical(stepsOf(b));
}
