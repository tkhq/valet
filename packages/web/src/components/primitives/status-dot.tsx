import type { HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

type Tone = "accent" | "info" | "warning" | "danger" | "success" | "neutral" | "current" | "outline";

const TONE: Record<Tone, string> = {
  accent: "bg-accent-500",
  // Blue marks live and unread state: a running thread, an unread reply.
  info: "bg-blue-500",
  // Amber is the palette's "waiting on a person" colour (see theme.css).
  warning: "bg-amber-500",
  danger: "bg-danger-500",
  success: "bg-moss",
  neutral: "bg-neutral-400",
  current: "bg-current",
  outline: "border border-muted",
};

/**
 * The one small round status mark. With `label` it is announced as an image;
 * without one it is decorative. Pass `className` for a data-driven colour
 * that no tone covers.
 */
export function StatusDot({ tone = "neutral", size = "md", pulse = false, label, className, ...rest }: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  tone?: Tone;
  size?: "sm" | "md";
  pulse?: boolean;
  label?: string;
}) {
  return (
    <span
      {...rest}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
        TONE[tone],
        pulse && "animate-pulse motion-reduce:animate-none",
        className,
      )}
    />
  );
}
