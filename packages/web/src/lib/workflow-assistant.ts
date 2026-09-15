/**
 * `WorkflowDefinitionSummary.definition` crosses the wire as `unknown`: the
 * list route ships the stored document without parsing it. A list that only
 * needs the assistant the definition pins reads it here instead of parsing
 * the whole graph.
 *
 * The server has a twin, `workflowAssistantId` in
 * `packages/api/src/workflows/service.ts`. That one THROWS a validation
 * error on a malformed id, because it guards a write: a definition that
 * names no valid orchestrator must not be stored or run. This one reads a
 * row for display, where the same definition must still render, so a
 * malformed or whitespace-only id reads as absent and the row falls back to
 * the owner's default assistant.
 */

/** The assistant a workflow definition pins, or undefined when it pins
 * none. An unpinned workflow runs as its owner's default assistant. */
export function workflowAssistantId(definition: unknown): string | undefined {
  if (typeof definition !== "object" || definition === null) return undefined;
  if (!("assistantId" in definition)) return undefined;
  const pinned: unknown = definition.assistantId;
  return typeof pinned === "string" && pinned.trim() !== "" ? pinned : undefined;
}
