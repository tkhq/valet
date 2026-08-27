import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { memoryHref } from "~/components/markdown";
import { Dialog, DialogContent, DialogTitle } from "~/components/primitives";
import { MemoryDoc } from "./memory-doc";

/**
 * Full-page memory reader that opens INSIDE a chat session (artifacts +
 * memory viewer design): a large dialog around the same `MemoryDoc` the
 * `/memory` route renders, so reading a long file or following its
 * cross-references never navigates away from the conversation.
 *
 * Cross-references navigate within the dialog (a local path stack with a
 * back button); "Open in Memory" jumps to the full two-pane page. The
 * share/download controls come with `MemoryDoc`'s action row, so this
 * dialog and the `/memory` page stay in lockstep.
 *
 * Unlike `MemoryDoc` (router-free by convention), this component calls
 * `useNavigate`: it is only ever mounted inside the routed app, and lazily
 * (`open` consumers render it on demand), so renderer unit tests never
 * instantiate it without a router.
 */
export function MemoryViewerDialog({
  path,
  open,
  onOpenChange,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  // Path stack for in-dialog cross-reference navigation. Re-seeded
  // whenever the dialog is (re)opened on a new path.
  const [stack, setStack] = useState<string[]>([path]);
  useEffect(() => {
    setStack([path]);
  }, [path, open]);
  const current = stack[stack.length - 1] ?? path;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl w-[92vw] h-[88vh] max-h-[88vh] p-0 gap-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        aria-describedby={undefined}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 pr-12">
          {stack.length > 1 && (
            <button
              type="button"
              onClick={() => setStack((s) => s.slice(0, -1))}
              className="rounded p-1 text-muted hover:text-ink"
              aria-label="Back to previous file"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </button>
          )}
          <DialogTitle className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
            {current}
          </DialogTitle>
          <a
            href={memoryHref(current)}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:text-moss"
            title="Open in the full memory explorer"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open in Memory
          </a>
        </header>
        <div className="overflow-y-auto">
          <MemoryDoc
            path={current}
            onNavigateToChat={() => {
              onOpenChange(false);
              void navigate({ to: "/chat" });
            }}
            onDeleted={() => onOpenChange(false)}
            onOpenPath={(next) => setStack((s) => [...s, next])}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
