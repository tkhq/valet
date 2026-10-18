import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

type Variant = "neutral" | "accent" | "success" | "warning" | "danger";

const VARIANT: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  // Solid dark background: light-mode `bg-accent-100` under
  // `dark:text-accent-100` was identical colours, an invisible badge.
  accent: "bg-accent-100 text-accent-700 dark:bg-accent-700 dark:text-accent-50",
  // Wash tokens keep one alpha per theme (`--success-wash` in theme.css).
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
        "inline-flex max-w-full items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide [overflow-wrap:anywhere]",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
