/**
 * The two control heights. `Button`, `Input`, `Select`, and `FilterChips` all
 * take their height and text size from this map, so controls in one row line
 * up when they share a size. Use `sm` in toolbars, filter rows, and row
 * actions. Use `md` in forms and dialogs. On a phone, every control is at
 * least 44px tall, so it is a usable touch target.
 */
export type ControlSize = "sm" | "md";

export const CONTROL_SIZE: Record<ControlSize, string> = {
  sm: "h-8 text-xs max-sm:min-h-11",
  md: "h-9 text-sm max-sm:min-h-11",
};
