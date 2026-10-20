import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export type CalloutTone = "neutral" | "warning" | "danger" | "success";

const TONE: Record<CalloutTone, string> = {
  neutral: "bg-ink-wash text-ink",
  warning: "bg-warning-wash text-ink",
  danger: "bg-danger-wash text-danger-600 dark:text-danger-500",
  success: "bg-success-wash text-ink",
};

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CalloutTone;
  /** Put the callout classes on the child element (a `label` or `ul`) instead of a `div`. */
  asChild?: boolean;
}

/**
 * The one tinted notice box: a setup warning, a load or submit error, or a
 * result. If the notice can appear after the first paint, add `role="alert"`
 * for an error or `role="status"` for other news, so a screen reader reads it.
 */
export const Callout = forwardRef<HTMLDivElement, CalloutProps>(function Callout(
  { tone = "neutral", asChild = false, className, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      ref={ref}
      className={cn("rounded border border-line px-3 py-2 text-sm", TONE[tone], className)}
      {...rest}
    />
  );
});
