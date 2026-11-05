import { useSyncExternalStore } from "react";

/** Below Tailwind's `md` breakpoint (768px). */
const PHONE = "(max-width: 767px)";

/**
 * Whether Valet shows its phone UI: Home as one conversation with Chat,
 * Tasks and Make, the drawer on every page, and the avatar menu. Wider
 * screens keep the web UI. False where the browser cannot answer (no
 * `matchMedia`), so tests get the web UI unless they mock this hook.
 */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(PHONE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches,
    () => false,
  );
}
