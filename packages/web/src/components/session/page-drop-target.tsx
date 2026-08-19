import { useEffect, useRef, useState, type ReactNode } from "react";
import { filesFromList, transferHasFiles } from "./composer-images";
import { useComposerDrop } from "./composer-drop-context";
import { cn } from "~/lib/cn";

/**
 * Whole-viewport drop target for images. Wraps its children and listens on
 * `document` for drag/drop events — a drop anywhere on the chat tab (not
 * only the composer's own form) reaches the composer's intake pipeline.
 *
 * Coexists with the composer's form-level drop handlers:
 *
 * - The overlay uses `pointer-events-none`, so drops fall through to the
 *   form and its `onDrop` runs as before.
 * - Before intake, this component checks whether the drop target lives
 *   inside the composer's form (`intake.ownedEl`). If it does, the form
 *   already handled the drop and we skip our own intake to avoid running
 *   the pipeline twice for the same files.
 *
 * `dragenter`/`dragleave` fire for every child element the pointer crosses;
 * a single leave doesn't mean the pointer left the window. Track depth so
 * the overlay hides only when the outermost leave fires (mirrors the same
 * dragDepth pattern the composer uses locally).
 */
export function PageDropTarget({ children }: { children: ReactNode }) {
  const channel = useComposerDrop();
  const intake = channel?.intake;
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    // No intake published yet — the effect will re-run once the composer
    // mounts and publishes, at which point the listeners attach.
    if (!intake) return;

    function isFileDrag(e: DragEvent): boolean {
      return transferHasFiles(e.dataTransfer?.types);
    }

    function ownedByComposer(target: EventTarget | null): boolean {
      if (!intake || !intake.ownedEl) return false;
      if (!(target instanceof Node)) return false;
      return intake.ownedEl.contains(target);
    }

    function onDragEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      if (intake!.blocked) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    }

    function onDragOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      if (intake!.blocked) return;
      // Without preventDefault the browser refuses the drop and opens the
      // image in a new tab.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }

    function onDragLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    }

    function onDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      // The composer's form-level `onDrop` handles drops that already
      // landed on the form. Skip ours to avoid running the same files
      // through intake twice.
      if (ownedByComposer(e.target)) {
        depth.current = 0;
        setActive(false);
        return;
      }
      if (intake!.blocked) {
        depth.current = 0;
        setActive(false);
        return;
      }
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      intake!.addFiles(filesFromList(e.dataTransfer?.files));
    }

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [intake]);

  return (
    <>
      {children}
      {active && (
        <div
          // Overlay is decorative — `pointer-events-none` guarantees the
          // drop event still reaches whatever's underneath (window /
          // composer form), so the intake logic above is the only path
          // that runs.
          className={cn(
            "fixed inset-0 z-50 pointer-events-none",
            "bg-moss/10 backdrop-blur-[1px]",
            "border-2 border-dashed border-moss",
            "flex items-center justify-center",
          )}
          data-testid="page-drop-overlay"
          role="presentation"
        >
          <div className="rounded-lg bg-[--bg] px-5 py-3 shadow-lg border border-moss/40 text-sm font-medium text-[--fg] animate-in fade-in zoom-in-95 duration-150">
            Drop images to attach
          </div>
        </div>
      )}
    </>
  );
}
