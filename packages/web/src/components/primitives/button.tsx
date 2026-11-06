import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";
import { CONTROL_SIZE, FOCUS_RING } from "./control.js";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon" | "iconSm";

const VARIANT: Record<Variant, string> = {
  // Moss is the accent for actions. `on-moss` is the text color measured
  // against it in every palette (white on the dark-mode moss is 2.82:1).
  primary: "bg-moss text-on-moss hover:opacity-90 active:opacity-95",
  secondary:
    "bg-neutral-100 text-neutral-900 hover:bg-neutral-200 active:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700",
  ghost:
    "bg-transparent text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
  danger:
    "bg-danger-600 text-white hover:bg-danger-500 active:bg-danger-600",
};

const SIZE: Record<Size, string> = {
  sm: `${CONTROL_SIZE.sm} px-2.5 gap-1.5`,
  md: `${CONTROL_SIZE.md} px-3.5 gap-2`,
  lg: "h-10 px-4 text-sm gap-2",
  // A square button that holds only an icon. Give it an aria-label. A text
  // button keeps at least its label's width, so only this size sets a width.
  icon: "h-6 w-6 p-0 text-muted max-sm:min-w-11",
  // A 32px square icon button for a row or a card header, 44px on a phone
  // and under a coarse pointer. Give it an aria-label.
  iconSm: "h-8 w-8 p-0 max-md:size-11 [@media(pointer:coarse)]:size-11",
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
        FOCUS_RING,
        "disabled:pointer-events-none disabled:opacity-50",
        "max-sm:min-h-11",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});

/** The text-link style: a moss label that underlines on hover. Apply it to a
 * router `Link` or an `<a>`; a link is not a button, so it has no wrapper.
 * `moss-text` is the moss that reaches 4.5:1 on the page in every palette. */
export const textLinkClass = "inline-flex items-center gap-1 font-medium text-moss-text underline-offset-4 hover:underline";
