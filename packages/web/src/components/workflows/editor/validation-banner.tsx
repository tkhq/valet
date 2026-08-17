/**
 * Validation banner (plan decision 10): lists every error from
 * `validateWorkflowDefinition()` and exposes `errorNodeIdsFrom`, which the
 * canvas (`FlowNode`'s `hasError` badge) and this banner both need to know
 * which nodes an error string is "about".
 */

/**
 * `@valet/workflow`'s validator messages are free text, but every message
 * that names a node embeds it as `node "<id>"` or `... node id "<id>"`
 * (see `packages/workflow/src/dag/validate.ts`) — including foreach-body
 * messages, whose "id" is a synthetic label like
 * `"foreach-1.body (foreach-1-body)"` rather than a real node id. Real
 * node ids match `^[a-z0-9][a-z0-9_-]*$`, so a captured label is reduced
 * to its leading run of id characters, which recovers the *owning*
 * foreach's id (`foreach-1`) for that case and is a no-op (full string)
 * for every plain node id.
 */
const NAMED_NODE_PATTERN = /\bnode(?:\s+id)?\s+"([^"]+)"/g;
const LEADING_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*/i;

export function errorNodeIdsFrom(errors: string[]): Set<string> {
  const ids = new Set<string>();
  for (const message of errors) {
    for (const match of message.matchAll(NAMED_NODE_PATTERN)) {
      const captured = match[1];
      if (!captured) continue;
      const leadingId = captured.match(LEADING_ID_PATTERN)?.[0];
      if (leadingId) ids.add(leadingId);
    }
  }
  return ids;
}

export interface ValidationBannerProps {
  errors: string[];
}

export function ValidationBanner({ errors }: ValidationBannerProps) {
  if (errors.length === 0) return null;

  return (
    <div
      role="alert"
      className="border-b border-danger-500/40 bg-danger-500/10 px-4 py-2 text-sm text-danger-700 dark:text-danger-400"
    >
      {/* The consequence, not only the count: `PUT /workflows/:id` rejects
          an invalid definition, so the editor holds Save off until these
          are fixed. Somebody who cannot see why a disabled button is
          disabled reads it as a broken editor. */}
      <p className="font-medium">
        {errors.length} validation {errors.length === 1 ? "error" : "errors"} — Save stays off until{" "}
        {errors.length === 1 ? "it is" : "they are"} fixed.
      </p>
      <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  );
}
