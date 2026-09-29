/**
 * Rewrites stored workflow definitions to the shape every supported binary
 * reads.
 *
 * The step type is `orchestrator`, the name dev-v2 validates and runs, so a
 * rollback to dev-v2 keeps working. The app labels it "Thread". A build of
 * this branch briefly stored `thread`; that rename is undone here. A
 * top-level `assistantId` named one of several assistants; a workspace now
 * has exactly one, so the field is dropped. dev-v2 reads a definition
 * without it as "use the owner's default". Foreach bodies hold a single
 * step and are normalized too.
 *
 * Input is untrusted JSON. Anything that is not a definition-shaped object is
 * returned unchanged, and so is a definition that needs no rewrite (same
 * reference), which lets callers skip a write.
 */
export function normalizeLegacyDefinition<T>(value: T): T {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return value;
  let changed = false;
  const nodes = value.nodes.map((node: unknown) => {
    const next = normalizeNode(node);
    if (next !== node) changed = true;
    return next;
  });
  const { assistantId, ...rest } = value;
  if (assistantId !== undefined) changed = true;
  if (!changed) return value;
  // `rest` is `value` without one key; the result keeps the caller's shape.
  return { ...rest, nodes } as T;
}

function normalizeNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const body = node.body !== undefined ? normalizeNode(node.body) : undefined;
  const renamed = node.type === "thread";
  if (!renamed && body === node.body) return node;
  return { ...node, ...(renamed ? { type: "orchestrator" } : {}), ...(body !== node.body ? { body } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
