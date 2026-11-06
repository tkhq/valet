import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check } from "lucide-react";
import { cn } from "~/lib/cn";
import { FOCUS_RING } from "./control.js";

export interface CheckboxProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Minimal checkbox, calm-companion styling (moss when checked). A
 * `role="checkbox"` toggle button, matching `Switch` — no
 * `@radix-ui/react-checkbox` dependency exists in this package. Reusable
 * paved-road primitive for a multi-select of boolean rows.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, onCheckedChange, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors touch-manipulation",
        FOCUS_RING,
        "disabled:pointer-events-none disabled:opacity-50",
        // An unchecked box needs a 3:1 outline to be seen at all (WCAG
        // 1.4.11); `--line` was about 1.2:1. Hover darkens it to `muted`.
        checked ? "border-moss bg-moss text-on-moss" : "border-control-border bg-paper hover:border-muted",
        className,
      )}
      {...rest}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
    </button>
  );
});
