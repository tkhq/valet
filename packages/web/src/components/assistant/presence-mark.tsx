import { useEffect, useState } from "react";
import { cn } from "~/lib/cn";

/**
 * The assistant's signature visual element (assistant-centered web UI,
 * decision 10): the name in the display face with a small living dot. In
 * the `hero` size the dot breathes beneath the name (the signature look);
 * in the `nav` size it sits inline beside the name as a compact status
 * indicator. This is the one place the calm-companion language spends
 * boldness — everything else stays quiet.
 *
 * - `idle`: slow breathing opacity loop (~2.4s), moss.
 * - `thinking`: quicker breathing loop (~1.2s), amber — the palette's
 *   "waiting" color (thinking, pending gates).
 * - `working`: steady (no animation), moss — children are running.
 *
 * `prefers-reduced-motion` collapses any state to a static dot, both via
 * JS (so the reported presence still reads correctly in tests/snapshots)
 * and via a CSS `@media` fallback in `theme.css`-adjacent global styles
 * for defense in depth.
 */
export type PresenceState = "idle" | "thinking" | "working";
export type PresenceSize = "hero" | "nav";

/**
 * Pure state → class mapping, extracted so it's testable without rendering
 * React or touching the DOM (CLAUDE.md: prefer pure functions over private
 * member access for tests).
 */
export function presenceDotClassName(state: PresenceState, reducedMotion: boolean): string {
  return cn(
    "presence-dot",
    `presence-dot--${state}`,
    reducedMotion && "presence-dot--static",
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => queryReducedMotion());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function queryReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const NAME_SIZE: Record<PresenceSize, string> = {
  hero: "font-display text-3xl text-ink",
  nav: "font-display text-sm font-medium text-ink",
};

const DOT_SIZE: Record<PresenceSize, string> = {
  hero: "h-2 w-2",
  nav: "h-1.5 w-1.5",
};

const WRAP_GAP: Record<PresenceSize, string> = {
  hero: "gap-2",
  nav: "gap-1.5",
};

/**
 * `hero` keeps the signature vertical stack (name in the display face with
 * the living dot breathing beneath it). `nav` lays out horizontally so the
 * dot reads as a small status indicator beside the name rather than
 * dangling orphaned on its own line under it.
 */
const LAYOUT: Record<PresenceSize, string> = {
  hero: "flex-col items-start",
  nav: "flex-row items-center",
};

export function PresenceMark({
  name,
  state,
  size = "nav",
  className,
}: {
  name: string;
  state: PresenceState;
  size?: PresenceSize;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className={cn("inline-flex", LAYOUT[size], WRAP_GAP[size], className)}>
      <span className={NAME_SIZE[size]}>{name}</span>
      <span
        aria-hidden
        data-presence={state}
        className={cn(presenceDotClassName(state, reducedMotion), DOT_SIZE[size], "rounded-full")}
      />
    </div>
  );
}
