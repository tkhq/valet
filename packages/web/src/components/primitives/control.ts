/**
 * The two control heights. `Button`, `Input`, `Select`, and `FilterChips` all
 * take their height and text size from this map, so controls in one row line
 * up when they share a size. Use `sm` in toolbars, filter rows, and row
 * actions. Use `md` in forms and dialogs. On a phone, every control is at
 * least 44px tall with 16px text: a usable touch target, no iOS zoom when a
 * field takes focus, and the same text size across a row.
 */
export type ControlSize = "sm" | "md";

export const CONTROL_SIZE: Record<ControlSize, string> = {
  sm: "h-8 text-xs max-sm:min-h-11 max-sm:text-base",
  md: "h-9 text-sm max-sm:min-h-11 max-sm:text-base",
};

/**
 * The one keyboard focus ring for a control: a 2px moss ring with a 2px gap
 * in the page color. `Button` (every variant), `Switch`, `Checkbox`, and
 * `RadioCard` use it. Moss on `--paper` passes the 3:1 non-text floor
 * (WCAG 1.4.11) in every palette; the grey ring it replaced measured 2.49:1.
 */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]";
