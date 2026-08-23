import { useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import type { MemoryLinkHandling } from "~/components/markdown";
import { MemoryViewerDialog } from "~/components/memory/memory-viewer-dialog";

/**
 * Shared plumbing for the mem_* tool renderers (artifacts + memory viewer
 * design): one state hook that yields
 *
 *   - `memoryLinks` — resolves the rendered file's cross-references
 *     against its own path and opens the target in the viewer dialog
 *     (without this, `../people/alice.md` was a dead external-tab link),
 *   - `expandButton` — the header action that opens the file itself
 *     full-page (hidden for directory reads, which have no single file),
 *   - `dialog` — the lazily-mounted `MemoryViewerDialog`.
 *
 * A hook rather than a component because the button and the dialog land in
 * different slots of the renderer body but share one open-path state.
 */
export function useMemoryViewer(fromPath: string): {
  memoryLinks: MemoryLinkHandling | undefined;
  expandButton: ReactNode;
  dialog: ReactNode;
} {
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  const isFile = fromPath !== "" && !fromPath.endsWith("/");
  const memoryLinks: MemoryLinkHandling | undefined = fromPath
    ? { fromPath, onNavigate: setViewerPath }
    : undefined;

  const expandButton = isFile ? (
    <button
      type="button"
      onClick={() => setViewerPath(fromPath)}
      className="rounded p-0.5 text-muted/70 hover:text-[--fg]"
      aria-label="Open full-page viewer"
      title="Open full-page viewer"
    >
      <Maximize2 className="h-3 w-3" aria-hidden />
    </button>
  ) : null;

  const dialog =
    viewerPath !== null ? (
      <MemoryViewerDialog
        path={viewerPath}
        open
        onOpenChange={(open) => {
          if (!open) setViewerPath(null);
        }}
      />
    ) : null;

  return { memoryLinks, expandButton, dialog };
}
