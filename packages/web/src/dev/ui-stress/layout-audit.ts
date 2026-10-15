/**
 * The gallery's layout audit. It names every element whose content spills
 * past the box that should hold it, so a regression shows on the page at
 * 375, 760 and 1280 px instead of in a screenshot someone has to read.
 *
 * An element overflows when its content is wider than its own box and its
 * overflow is visible. That alone is not a bug: a full-bleed row may reach
 * into its card's padding on purpose. It counts only when the spill passes
 * the nearest ancestor that clips or bounds it: a scroll container, a
 * popover, or a bordered card. Code blocks and charts scroll by design and
 * are skipped. A text line that ends in an ellipsis is truncated on purpose.
 */
export interface LayoutFinding {
  /** The tag and first classes of the overflowing element. */
  element: string;
  /** The start of its text, to find it on the page. */
  text: string;
  /** How far, in px, its content passes the boundary. */
  overflow: number;
}

const SLACK_PX = 2;

function isBoundary(element: Element): boolean {
  const style = getComputedStyle(element);
  if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
  if (element.hasAttribute("data-radix-popper-content-wrapper")) return true;
  return parseFloat(style.borderRightWidth) > 0 && parseFloat(style.borderLeftWidth) > 0;
}

function describe(element: Element): string {
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
  return classes ? `${element.tagName.toLowerCase()}.${classes}` : element.tagName.toLowerCase();
}

export function auditLayout(root: Element): LayoutFinding[] {
  const flagged: Array<{ element: Element; overflow: number }> = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.closest("pre, svg, [data-layout-audit-skip]")) continue;
    const style = getComputedStyle(element);
    if (style.overflowX !== "visible" || style.textOverflow === "ellipsis") continue;
    if (element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + SLACK_PX) continue;
    const contentRight = element.getBoundingClientRect().left + element.scrollWidth;
    let boundary = element.parentElement;
    while (boundary && !isBoundary(boundary)) boundary = boundary.parentElement;
    const limit = boundary ? boundary.getBoundingClientRect().right : document.documentElement.clientWidth;
    const overflow = Math.round(contentRight - limit);
    if (overflow > SLACK_PX) flagged.push({ element, overflow });
  }
  // Report the innermost element: an ancestor of a finding only repeats it.
  return flagged
    .filter(({ element }) => !flagged.some((other) => other.element !== element && element.contains(other.element)))
    .map(({ element, overflow }) => ({ element: describe(element), text: (element.textContent ?? "").trim().slice(0, 60), overflow }));
}
