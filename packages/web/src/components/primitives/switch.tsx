import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Minimal on/off switch, calm-companion styling (moss when on). Not
 * Radix-backed — no `@radix-ui/react-switch` dependency exists in this
 * package yet, and a `role="switch"` toggle button covers the one use
 * (Settings → Notifications) without adding one for a single control.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, className, disabled, ...rest },
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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]",
        "disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-moss" : "bg-neutral-300 dark:bg-neutral-700",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
});
