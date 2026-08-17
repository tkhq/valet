import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

type Variant = "neutral" | "accent" | "success" | "warning" | "danger";

const VARIANT: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  // Solid dark background, not `dark:bg-accent-700/30`: the accent scale is
  // raw `oklch(...)` strings, so Tailwind cannot inject an alpha channel and
  // the slash-opacity class silently no-ops (see the OPACITY-MODIFIER TRAP
  // note in theme.css). That left light-mode `bg-accent-100` under
  // `dark:text-accent-100` — identical colours, an invisible badge.
  accent: "bg-accent-100 text-accent-700 dark:bg-accent-700 dark:text-accent-50",
  // Wash tokens, not `bg-success-500/15`. The `success`/`danger` scales are
  // raw `oklch(...)` strings, so the slash modifier produced NO rule at all
  // and both badges rendered as bare coloured text with no pill — the same
  // trap the `accent` note above describes. See `--success-wash` in
  // theme.css; alpha belongs in the token.
  success: "bg-success-wash text-success-600 dark:text-success-500",
  // Amber is the palette's documented "waiting" colour (see the presence
  // mark in theme.css), so it carries states that are blocked on a person.
  warning: "bg-warning-wash text-warning-fg",
  danger: "bg-danger-wash text-danger-600 dark:text-danger-500",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = "neutral", ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
