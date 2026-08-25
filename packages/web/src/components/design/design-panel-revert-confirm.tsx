/**
 * One confirm step before a revert. The history panel's button used to act
 * immediately — a misclick rewrote the canvas with no preview and no way to
 * see what the target revision even looked like. This dialog names the
 * target (id, summary, age) and renders a small preview through the same
 * `DesignRenderer` the canvas uses, so the preview can never drift from
 * what the revert would actually show.
 *
 * Not the shared `ConfirmDialog` primitive: that one takes a plain-string
 * description and has no body slot for the preview.
 */
import type { DesignRevisionSummary } from "@valet/api/wire";
import { Button, Dialog, DialogContent, DialogFooter, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { DesignRenderer } from "./design-renderer";

export function DesignPanelRevertConfirm({
  target,
  previewContent,
  previewLoading,
  tokens,
  isSlides,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  target: DesignRevisionSummary;
  /** The target revision's full content, when the revision read has
   * resolved. Undefined = no preview (still loading, or the read failed). */
  previewContent?: string;
  previewLoading?: boolean;
  tokens: Record<string, string>;
  isSlides: boolean;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        title={`Revert to ${target.revision}?`}
        description="Revert copies that revision into a new one. Later revisions stay in the history."
      >
        <div className="text-sm text-ink">
          <span className="font-mono text-xs">{target.revision}</span>
          {target.summary ? <span> — {target.summary}</span> : null}
          <span className="text-muted"> · {relativeTime(target.createdAt)}</span>
        </div>
        {previewLoading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <Spinner /> Loading the preview…
          </div>
        ) : previewContent ? (
          <>
            <div className="pointer-events-none mt-2 max-h-64 overflow-hidden rounded border border-line bg-white dark:bg-neutral-950">
              <DesignRenderer
                content={previewContent}
                tokens={tokens}
                activeSlideIndex={isSlides ? 0 : undefined}
              />
            </div>
            {isSlides && (
              <p className="mt-1 text-[11px] text-muted">The preview shows the first slide.</p>
            )}
          </>
        ) : (
          <p className="mt-2 text-xs text-muted">No preview is available for this revision.</p>
        )}
        {error && <p className="mt-2 text-xs text-danger-600">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={pending} onClick={onConfirm}>
            {pending ? "Reverting…" : "Revert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
