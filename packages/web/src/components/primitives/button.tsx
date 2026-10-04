import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANT: Record<Variant, string> = {
  // Calm-companion palette (decision 9): moss is the accent for actions.
  primary: "bg-moss text-white hover:opacity-90 active:opacity-95 focus-visible:ring-moss",
  secondary:
    "bg-neutral-100 text-neutral-900 hover:bg-neutral-200 active:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 focus-visible:ring-neutral-400",
  ghost:
    "bg-transparent text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 focus-visible:ring-neutral-400",
  danger:
    "bg-danger-600 text-white hover:bg-danger-500 active:bg-danger-600 focus-visible:ring-danger-500",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-10 px-4 text-sm gap-2",
  // A square button that holds only an icon. Give it an aria-label.
  icon: "h-6 w-6 p-0 text-muted",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Render as a different element via Radix Slot (e.g. Link). */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", asChild = false, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(
        // `touch-manipulation` removes the ~300ms tap delay mobile browsers
        // hold to see if the tap is a double-tap zoom.
        "inline-flex items-center justify-center whitespace-nowrap rounded font-medium transition-colors touch-manipulation",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]",
        "disabled:pointer-events-none disabled:opacity-50",
        "max-sm:min-h-11 max-sm:min-w-11",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});

/** The text-link style: a moss label that underlines on hover. Apply it to a
 * router `Link` or an `<a>`; a link is not a button, so it has no wrapper. */
export const textLinkClass = "inline-flex items-center gap-1 font-medium text-moss underline-offset-4 hover:underline";
