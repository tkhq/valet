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
