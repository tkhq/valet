/** Smallest horizontal travel, in CSS pixels, that counts as a swipe. */
export const SWIPE_MIN_DISTANCE = 64;
/** A swipe must travel at least this many times further sideways than up or down. */
export const SWIPE_HORIZONTAL_RATIO = 2;

export type SwipeDirection = "left" | "right";

/**
 * Classifies a touch movement. `dx` and `dy` are the end minus the start
 * position. Returns `null` for a short or mostly vertical movement, so
 * page scrolling is never taken for a swipe.
 */
export function classifySwipe(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_HORIZONTAL_RATIO) return null;
  return dx > 0 ? "right" : "left";
}

const INTERACTIVE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function scrollsHorizontally(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  const overflowX = getComputedStyle(el).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

/**
 * Whether a touch that starts on `target` belongs to the element, not to a
 * page-level swipe: a text field, or any horizontally scrollable ancestor
 * such as a code block or table.
 */
export function swipeStartsInProtectedElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(INTERACTIVE)) return true;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (scrollsHorizontally(el)) return true;
  }
  return false;
}
