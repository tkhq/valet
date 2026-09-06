import { useSyncExternalStore } from "react";
import type { MermaidTheme } from "./mermaid";

function darkMedia(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;
}

function resolvedTheme(): MermaidTheme {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark") return "dark";
  if (explicit === "light") return "default";
  return darkMedia()?.matches ? "dark" : "default";
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = darkMedia();
  media?.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

/** Resolve explicit and system polarity for Mermaid's light/dark renderer. */
export function useMermaidTheme(): MermaidTheme {
  return useSyncExternalStore(subscribeTheme, resolvedTheme, () => "default");
}
