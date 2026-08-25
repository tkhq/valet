/**
 * Comments panel — the management side of commenting (Valet Design spec).
 * The comment FORM creates; this panel lists the open comments and lets the
 * user resolve them. Without it a comment was write-only: never listed,
 * never closable, and invisible forever once the agent rewrote its target
 * element away. Comments whose anchor is gone from the current revision are
 * flagged instead of silently unpinnable.
 *
 * The api has no delete route — "Resolve" is the only close action.
 */
import type { DesignCommentWire } from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";

export function DesignPanelComments({
  comments,
  existingVdids,
  resolvingId,
  error,
  onResolve,
}: {
  comments: DesignCommentWire[];
  /** vdids present in the CURRENT revision. A comment whose vdid is not in
   * this set has lost its anchor (the element was rewritten away). */
  existingVdids: ReadonlySet<string>;
  /** Id of the comment a resolve is running for, or null. */
  resolvingId: string | null;
  error?: string;
  onResolve: (commentId: string) => void;
}) {
  const open = comments
    .filter((c) => c.resolvedAt === null)
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line" aria-label="Comments">
      <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Comments — {open.length} open
      </div>
      {error && <div className="px-3 py-2 text-xs text-danger-600">{error}</div>}
      <ul className="flex-1 overflow-y-auto">
        {open.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted">No open comments.</li>
        )}
        {open.map((c) => (
          <li key={c.id} className="border-b border-line/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[10px] text-muted">
                [data-vdid={c.vdid}]
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-muted">
                {relativeTime(c.createdAt)}
              </span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink">{c.body}</p>
            {!existingVdids.has(c.vdid) && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
                The target element no longer exists in the current revision.
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="mt-1.5"
              disabled={resolvingId === c.id}
              onClick={() => onResolve(c.id)}
            >
              {resolvingId === c.id ? "Resolving…" : "Resolve"}
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
