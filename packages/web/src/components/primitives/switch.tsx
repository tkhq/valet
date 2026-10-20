import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** `md` (the default) is 36 by 20. `sm` is 28 by 16, for a control in a dense list row. */
  size?: "sm" | "md";
}

const TRACK = { sm: "h-4 w-7", md: "h-5 w-9" } as const;
const THUMB = { sm: "h-3 w-3", md: "h-3.5 w-3.5" } as const;
const THUMB_ON = { sm: "translate-x-[14px]", md: "translate-x-[18px]" } as const;
const THUMB_OFF = { sm: "translate-x-[2px]", md: "translate-x-[3px]" } as const;

/**
 * Minimal on/off switch, calm-companion styling (moss when on). Not
 * Radix-backed — no `@radix-ui/react-switch` dependency exists in this
 * package yet, and a `role="switch"` toggle button covers the one use
 * (Settings → Notifications) without adding one for a single control.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, size = "md", className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors touch-manipulation",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]",
        TRACK[size],
        "disabled:pointer-events-none disabled:opacity-50",
        "max-sm:after:absolute max-sm:after:-inset-x-1 max-sm:after:-inset-y-3",
        checked ? "bg-moss" : "bg-neutral-300 dark:bg-neutral-700",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
          THUMB[size],
          checked ? THUMB_ON[size] : THUMB_OFF[size],
        )}
      />
    </button>
  );
});
