import {
  useCallback,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * A horizontal resize between two panes, driven by a drag handle plus the
 * keyboard, persisted to localStorage. The width is exposed as a CSS variable
 * on `containerStyle` so the consumer applies it through a responsive Tailwind
 * class (e.g. `md:w-[var(--x)]`) — the resize then only affects the
 * side-by-side layout, never the stacked/mobile one, with no JS media query.
 *
 * `side` names which pane (relative to the handle) carries the width: `"right"`
 * for a right-hand panel (chat | handle | PANEL), `"left"` for a left-hand list
 * (LIST | handle | detail). It sets the drag direction and the arrow-key sense
 * so a bigger number always means a wider sized-pane.
 */
export interface UseResizablePaneOptions {
  storageKey: string;
  /** CSS custom property the width is published under, e.g. `--sec-panel-w`. */
  cssVar: string;
  defaultWidth: number;
  min: number;
  max: number;
  step?: number;
  side: "left" | "right";
  ariaLabel: string;
}

export interface ResizeHandleProps {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  tabIndex: number;
  onPointerDown: (e: PointerEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface ResizablePane {
  width: number;
  /** Spread on the flex container that holds both panes and the handle. */
  containerStyle: CSSProperties;
  /** Spread on the separator element between the panes. */
  handleProps: ResizeHandleProps;
}

export function useResizablePane(opts: UseResizablePaneOptions): ResizablePane {
  const { storageKey, cssVar, defaultWidth, min, max, step = 24, side, ariaLabel } = opts;
  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, Math.round(n))), [min, max]);

  const [width, setWidthState] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(n) ? clamp(n) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  const setWidth = useCallback(
    (n: number) => {
      const c = clamp(n);
      setWidthState(c);
      try {
        window.localStorage.setItem(storageKey, String(c));
      } catch {
        // Private mode: lose persistence, not the resize.
      }
    },
    [clamp, storageKey],
  );

  // A left-hand sized pane grows as the pointer moves right (dir +1); a
  // right-hand one grows as it moves left (dir −1).
  const dir = side === "left" ? 1 : -1;

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: globalThis.PointerEvent) => setWidth(startWidth + dir * (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // ArrowLeft moves the divider left; whether that widens or narrows the
    // sized pane depends on which side it is on.
    const leftDelta = side === "left" ? -step : step;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(width + leftDelta);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(width - leftDelta);
    }
  };

  return {
    width,
    containerStyle: { [cssVar]: `${width}px` } as CSSProperties,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": ariaLabel,
      "aria-valuenow": width,
      "aria-valuemin": min,
      "aria-valuemax": max,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}
