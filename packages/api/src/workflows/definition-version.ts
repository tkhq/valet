/**
 * `definitionVersionId` (Phase 5 plan decision 17): sha256 of the canonical
 * `JSON.stringify` of a workflow definition, computed at run-start time. The
 * run row snapshots the definition itself, so later edits to the
 * `workflow_definitions` row never affect an in-flight run — this hash is
 * purely an identifying label for "which version was this run started
 * against," not a cache/dedupe key.
 */
import { createHash } from "node:crypto";

export function definitionVersionId(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}
