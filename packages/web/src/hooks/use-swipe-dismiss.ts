import { useRef, type TouchEvent } from "react";

/** How far a finger must travel, in CSS pixels, before a swipe dismisses. */
const SWIPE_PX = 64;

type Point = { x: number; y: number };

/**
 * Pure: whether a touch from `start` to `end` dismisses a surface that leaves
 * toward `direction`. The swipe must travel `SWIPE_PX` and stay mostly on its
 * axis, so a vertical scroll never closes the drawer.
 */
export function isDismissSwipe(start: Point, end: Point, direction: "left" | "down"): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return direction === "left"
    ? dx <= -SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5
    : dy >= SWIPE_PX && Math.abs(dy) > Math.abs(dx) * 1.5;
}

/**
 * Touch handlers that call `onDismiss` on a swipe toward `direction`: left
 * for the phone drawer, down for a bottom sheet. A downward swipe counts only
 * when the surface starts scrolled to its top, so scrolling its content up
 * does not close it.
 */
export function useSwipeDismiss(direction: "left" | "down", onDismiss: () => void) {
  const start = useRef<Point | null>(null);
  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      const scrolled = direction === "down" && event.currentTarget.scrollTop > 0;
      start.current = touch && !scrolled ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const touch = event.changedTouches[0];
      if (start.current && touch && isDismissSwipe(start.current, { x: touch.clientX, y: touch.clientY }, direction)) onDismiss();
      start.current = null;
    },
  };
}
