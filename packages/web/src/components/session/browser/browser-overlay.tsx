import { useState } from "react";
import { ArrowUpRight, Grip, Maximize2, Minus, X } from "lucide-react";
import { Button } from "~/components/primitives";
import { BrowserPreviewFeed } from "./browser-preview-feed";
import { useBrowserOverlayGeometry } from "./use-browser-overlay-geometry";

export function BrowserOverlay({
  sessionId,
  threadId,
  working,
  minimized,
  onMinimize,
  onRestore,
  onClose,
  onExpand,
}: {
  sessionId: string;
  threadId?: string;
  working: boolean;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onExpand: () => void;
}) {
  const geometry = useBrowserOverlayGeometry(minimized);
  const [choice, setChoice] = useState<string>();
  return (
    <div
      ref={geometry.containerRef}
      className="pointer-events-none absolute inset-3 z-20"
    >
      {geometry.ready && (
        <section
          role="region"
          aria-label="Browser preview"
          style={geometry.style}
          className="pointer-events-auto absolute left-[var(--preview-x)] top-[var(--preview-y)] flex h-[var(--preview-height)] w-[var(--preview-width)] flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-2xl"
        >
          <div className="flex h-12 shrink-0 items-center gap-0.5 px-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Move browser preview"
              title="Drag to move. Arrow keys move; Shift moves faster; Home resets."
              className="h-11 min-w-0 flex-1 touch-none cursor-move justify-start gap-2 overflow-hidden text-ink"
              {...geometry.move}
            >
              <Grip className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              <span className="truncate">Browser</span>
              {working && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-moss animate-pulse motion-reduce:animate-none"
                  aria-label="Browser working"
                />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 shrink-0 px-0"
              aria-label={
                minimized
                  ? "Restore browser preview"
                  : "Minimize browser preview"
              }
              title={minimized ? "Restore preview" : "Minimize preview"}
              onClick={minimized ? onRestore : onMinimize}
            >
              {minimized ? (
                <Maximize2 className="h-3.5 w-3.5" />
              ) : (
                <Minus className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 shrink-0 px-0"
              aria-label="Open full Browser view"
              title="Open full Browser view"
              onClick={onExpand}
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 shrink-0 px-0"
              aria-label="Close browser preview"
              title="Close preview"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {!geometry.compact && (
            <>
              <BrowserPreviewFeed
                sessionId={sessionId}
                threadId={threadId}
                working={working}
                choice={choice}
                onChoose={setChoice}
              />
              <div className="flex h-8 shrink-0 items-center justify-between border-t border-line pl-3">
                <span className="text-[10px] text-muted">
                  Read-only preview
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Resize browser preview"
                  title="Drag to resize. Arrow keys resize; Shift resizes faster; Home resets."
                  className="h-8 w-11 touch-none cursor-nwse-resize px-0 max-sm:min-h-0"
                  {...geometry.resize}
                >
                  <Grip className="h-3 w-3 text-muted" aria-hidden />
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
