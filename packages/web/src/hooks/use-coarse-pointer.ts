import { useSyncExternalStore } from "react";

const COARSE = "(pointer: coarse)";

/**
 * Whether the primary input is a touch screen. The Return key on a phone
 * keyboard means "new line", not "send", so the composer asks this. It
 * follows the input device, not the screen width: a narrow desktop window
 * still has a hardware Enter key. False where the browser cannot answer
 * (no `matchMedia`), so tests get desktop behavior unless they mock it.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(COARSE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(COARSE).matches,
    () => false,
  );
}
