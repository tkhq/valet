import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Follow reader scroll direction without reacting to streaming or layout changes. */
export function useScrollHeader(containerRef: RefObject<HTMLDivElement | null>, threadId?: string) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const previous = useRef(0);
  const travel = useRef(0);
  const userScrollUntil = useRef(0);
  const focused = useRef<EventTarget | null>(null);

  const syncPosition = useCallback(() => {
    const el = containerRef.current;
    previous.current = el ? Math.max(0, Math.min(el.scrollTop, el.scrollHeight - el.clientHeight)) : 0;
    travel.current = 0;
    userScrollUntil.current = 0;
  }, [containerRef]);

  useLayoutEffect(() => {
    const reset = () => {
      syncPosition();
      setHidden(false);
    };
    reset();
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, [threadId, syncPosition]);

  function recordIntent(target: EventTarget | null) {
    const active = document.activeElement;
    // A touch or wheel over messages leaves header buttons behind. Keep an
    // active title edit visible until the reader saves or cancels it.
    if (target instanceof Node && !headerRef.current?.contains(target)
      && active instanceof HTMLElement && headerRef.current?.contains(active)
      && !active.matches("input, textarea, [contenteditable=true]")) {
      active.blur();
    }
    userScrollUntil.current = Date.now() + 250;
  }

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const top = Math.max(0, Math.min(el.scrollTop, el.scrollHeight - el.clientHeight));
    const delta = top - previous.current;
    previous.current = top;
    if (top <= 12 || focused.current === document.activeElement) {
      travel.current = 0;
      setHidden(false);
      return;
    }
    if (Date.now() > userScrollUntil.current) {
      travel.current = 0;
      return;
    }
    if (delta === 0) return;
    // Scroll events extend the input window through touch momentum.
    userScrollUntil.current = Date.now() + 250;
    travel.current = Math.sign(delta) === Math.sign(travel.current) ? travel.current + delta : delta;
    if (Math.abs(travel.current) >= 12) {
      setHidden(travel.current > 0);
      travel.current = 0;
    }
  }

  return {
    hidden,
    headerRef,
    syncPosition,
    onScroll,
    recordIntent,
    onFocus(event: { target: EventTarget }) { focused.current = event.target; setHidden(false); },
    onBlur() { focused.current = null; },
  };
}
