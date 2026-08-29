import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check } from "lucide-react";
import { cn } from "~/lib/cn";

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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]",
        "disabled:pointer-events-none disabled:opacity-50",
        checked ? "border-moss bg-moss text-paper" : "border-line bg-paper hover:border-ink-wash-strong",
        className,
      )}
      {...rest}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
    </button>
  );
});
