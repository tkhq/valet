import { useEffect, useRef } from "react";
import { classifySwipe, swipeStartsInProtectedElement } from "~/lib/swipe";

/**
 * An open modal. Radix marks its dialogs `data-state="open"`. An inline card
 * with `role="dialog"` (a decision gate) or a hidden dialog is not a modal.
 */
const OPEN_MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]';

/** Touches that start this close to the left edge belong to the system back gesture. */
export const EDGE_GUARD_PX = 24;

/**
 * Phone drawer gestures. The drawer sits at the left edge, so a swipe to the
 * right (finger moves left to right) opens it and a swipe to the left closes
 * it. Mostly vertical moves, moves that start in a text field or a
 * horizontally scrollable element, and moves while another dialog is open
 * are left alone. Touches that start within 24px of the left edge are
 * left to the system back gesture.
 */
export function useDrawerSwipe({ enabled, open, onOpen, onClose }: {
  enabled: boolean;
  open: boolean;
  onOpen(): void;
  onClose(): void;
}) {
  const latest = useRef({ open, onOpen, onClose });
  useEffect(() => {
    latest.current = { open, onOpen, onClose };
  });

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;

    function onTouchStart(e: TouchEvent) {
      start = null;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX < EDGE_GUARD_PX) return;
      if (swipeStartsInProtectedElement(e.target)) return;
      // The open drawer is itself a dialog; any other dialog blocks the gesture.
      if (!latest.current.open && document.querySelector(OPEN_MODAL)) return;
      start = { x: touch.clientX, y: touch.clientY };
    }
    function onTouchEnd(e: TouchEvent) {
      const from = start;
      start = null;
      const touch = e.changedTouches[0];
      if (!from || !touch) return;
      const direction = classifySwipe(touch.clientX - from.x, touch.clientY - from.y);
      if (direction === "right" && !latest.current.open) latest.current.onOpen();
      else if (direction === "left" && latest.current.open) latest.current.onClose();
    }
    function cancel() {
      start = null;
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", cancel);
    };
  }, [enabled]);
}
