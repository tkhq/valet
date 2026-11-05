import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

interface Bounds {
  width: number;
  height: number;
}
interface Rect extends Bounds {
  x: number;
  y: number;
}
const HEADER_HEIGHT = 48;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

export function clampOverlay(
  rect: Rect,
  bounds: Bounds,
  compact = false,
): Rect {
  const width = clamp(rect.width, Math.min(280, bounds.width), bounds.width);
  const height = compact
    ? Math.min(HEADER_HEIGHT, bounds.height)
    : clamp(rect.height, Math.min(200, bounds.height), bounds.height);
  return {
    width,
    height,
    x: clamp(rect.x, 0, bounds.width - width),
    y: clamp(rect.y, 0, bounds.height - height),
  };
}
function initialRect(bounds: Bounds): Rect {
  const width = Math.min(480, bounds.width);
  return clampOverlay(
    { x: bounds.width - width, y: 128, width, height: 340 },
    bounds,
  );
}

export function useBrowserOverlayGeometry(minimized: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds>({ width: 0, height: 0 });
  const [desired, setDesired] = useState<Rect>();
  const compact = minimized || bounds.height < 200;
  const expanded = desired ?? initialRect(bounds);
  const rect = clampOverlay(expanded, bounds, compact);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    origin: Rect;
    mode: "move" | "resize";
  } | null>(null);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect();
      setBounds({ width: next.width, height: next.height });
      gesture.current = null;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      gesture.current = null;
    };
  }, []);

  function handles(mode: "move" | "resize") {
    const stop = (event: PointerEvent<HTMLButtonElement>) => {
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          origin: { ...rect, height: compact ? expanded.height : rect.height },
          mode,
        };
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const start = gesture.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const next =
          start.mode === "move"
            ? {
                ...start.origin,
                x: start.origin.x + dx,
                y: start.origin.y + dy,
              }
            : {
                ...start.origin,
                width: start.origin.width + dx,
                height: start.origin.height + dy,
              };
        const clamped = clampOverlay(next, bounds, compact);
        setDesired(compact ? { ...clamped, height: next.height } : clamped);
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture() {
        gesture.current = null;
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key === "Home") {
          event.preventDefault();
          setDesired(undefined);
          return;
        }
        const step = event.shiftKey ? 48 : 16;
        const dx =
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        const dy =
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0;
        if (!dx && !dy) return;
        event.preventDefault();
        const next =
          mode === "move"
            ? { ...rect, x: rect.x + dx, y: rect.y + dy }
            : { ...rect, width: rect.width + dx, height: rect.height + dy };
        const clamped = clampOverlay(next, bounds, compact);
        setDesired(compact ? { ...clamped, height: expanded.height } : clamped);
      },
    };
  }
  const style: CSSProperties = {
    "--preview-x": `${rect.x}px`,
    "--preview-y": `${rect.y}px`,
    "--preview-width": `${rect.width}px`,
    "--preview-height": `${rect.height}px`,
  } as CSSProperties;
  return {
    containerRef,
    style,
    compact,
    ready: bounds.width > 0 && bounds.height >= HEADER_HEIGHT,
    move: handles("move"),
    resize: handles("resize"),
  };
}
