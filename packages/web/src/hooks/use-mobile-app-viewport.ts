import { useEffect, type RefObject } from "react";

/** Safari resizes and pans the visual viewport when the keyboard opens.
 * Keep the fixed phone shell within that viewport without moving the document. */
export function useMobileAppViewport(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const shell = ref.current;
    if (!enabled || !shell) return;
    const viewport = window.visualViewport;
    // Portaled dialogs need the same keyboard bounds as the shell.
    const root = shell.ownerDocument.documentElement;
    const previousHeight = root.style.getPropertyValue("--app-viewport-height");
    const previousTop = root.style.getPropertyValue("--app-viewport-top");
    function update() {
      if (!shell) return;
      // Let pinch zoom remain a browser gesture rather than resizing the app.
      if (viewport && viewport.scale !== 1) return;
      shell.style.setProperty("--app-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      shell.style.setProperty("--app-viewport-top", `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
      root.style.setProperty("--app-viewport-height", shell.style.getPropertyValue("--app-viewport-height"));
      root.style.setProperty("--app-viewport-top", shell.style.getPropertyValue("--app-viewport-top"));
    }
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      shell.style.removeProperty("--app-viewport-height");
      shell.style.removeProperty("--app-viewport-top");
      if (previousHeight) root.style.setProperty("--app-viewport-height", previousHeight);
      else root.style.removeProperty("--app-viewport-height");
      if (previousTop) root.style.setProperty("--app-viewport-top", previousTop);
      else root.style.removeProperty("--app-viewport-top");
    };
  }, [ref, enabled]);
}
