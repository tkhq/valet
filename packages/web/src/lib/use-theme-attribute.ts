import { useSyncExternalStore } from "react";

export type ThemeAttribute = "light" | "dark" | null;

function readThemeAttribute(): ThemeAttribute {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : null;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * The viewer's explicit theme choice, read from the `data-theme` attribute
 * `lib/theme.ts` stamps on <html>. `null` means the system default: the
 * attribute is absent and prefers-color-scheme governs.
 */
export function useThemeAttribute(): ThemeAttribute {
  return useSyncExternalStore(subscribe, readThemeAttribute, () => null);
}
