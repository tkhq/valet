import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";
import { FOCUS_RING } from "./control.js";

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
        FOCUS_RING,
        TRACK[size],
        "disabled:pointer-events-none disabled:opacity-50",
        "max-sm:after:absolute max-sm:after:-inset-x-1 max-sm:after:-inset-y-3",
        // Off: a faint track with a 1px `control-border` outline and a
        // `control-border` thumb, as in Material 3's switch. The outline on
        // the page and the thumb on the track each measure 3:1 or more
        // (WCAG 1.4.11, `theme.tokens.test.ts`). The outline is an inset box
        // shadow, not `ring-1 ring-inset`: a ring would make the focus ring
        // inset too, and Tailwind composes a box shadow under the ring.
        checked ? "bg-moss" : "bg-ink-wash-strong shadow-[inset_0_0_0_1px_var(--control-border)]",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block transform rounded-full shadow transition-transform motion-reduce:transition-none",
          THUMB[size],
          checked ? cn(THUMB_ON[size], "bg-on-moss") : cn(THUMB_OFF[size], "bg-control-border"),
        )}
      />
    </button>
  );
});
