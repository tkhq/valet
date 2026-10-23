import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "~/lib/cn";

/**
 * Trace: quiet one-line steps for work an agent did, after the shadcn/ui
 * Trace pattern. A line is muted text with an icon; it reads as a record,
 * not as a card. A running line shimmers, a failed line is red, and a line
 * with detail opens in place.
 */
export type TraceStatus = "running" | "error" | "done";

/** A light band that crosses running text. Reduced motion keeps the plain muted text. */
export const SHIMMER_TEXT =
  "bg-[linear-gradient(90deg,var(--muted)_40%,var(--ink)_50%,var(--muted)_60%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-text-shimmer motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted";

const STATUS_TEXT: Record<TraceStatus, string> = {
  running: "text-muted",
  error: "text-danger-600 dark:text-danger-500",
  done: "text-muted",
};

/**
 * One line: icon, title, an optional quiet detail (a count, a file, an
 * exit code), and a chevron when it opens. With `children` it is a button
 * that shows them beneath it; with `onSelect` it is a button that does
 * something else, such as opening a page. Otherwise it is plain text.
 */
export function TraceLine({ icon, title, detail, keepDetail = false, status = "done", defaultOpen = false, label, className, iconClassName, onSelect, children }: {
  icon: ReactNode;
  /** The detail stays whole when the line is short of room, such as a failure count. */
  keepDetail?: boolean;
  iconClassName?: string;
  title: ReactNode;
  detail?: ReactNode;
  status?: TraceStatus;
  defaultOpen?: boolean;
  /** The accessible name when the title alone does not say what opens. */
  label?: string;
  className?: string;
  onSelect?: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = <>
    <span aria-hidden className={cn("flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5", iconClassName)}>{icon}</span>
    <span className={cn("min-w-0 truncate", status === "running" && SHIMMER_TEXT)}>{title}</span>
    {/* The detail gives way first: on a narrow screen the title stays readable. */}
    {detail && <span className={cn("text-xs text-muted/80 tabular-nums", keepDetail ? "shrink-0" : "min-w-0 shrink-[4] truncate")}>{detail}</span>}
  </>;
  const line = cn("flex w-fit max-w-full min-w-0 items-center gap-1.5 text-sm", STATUS_TEXT[status]);
  const button = "group/trace rounded text-left hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40 max-sm:min-h-9";
  if (!children && onSelect) return <button type="button" aria-label={label} onClick={onSelect} className={cn(line, button, className)}>{body}</button>;
  if (!children) return <div className={cn(line, className)}>{body}</div>;
  return <div className={cn("min-w-0", className)}>
    <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(o => !o)}
      className={cn(line, button)}>
      {body}
      <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open ? "rotate-90" : "opacity-0 group-hover/trace:opacity-100 group-focus-visible/trace:opacity-100 max-md:opacity-100")} />
    </button>
    {open && <div className="mt-1.5 min-w-0">{children}</div>}
  </div>;
}

/**
 * A timeline of steps: an icon column joined by a hairline, one row per
 * step. Each row is a `TraceLine`; a row with detail opens beneath itself.
 */
export function TraceList({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("relative min-w-0 space-y-1.5 pl-1 before:absolute before:bottom-2 before:left-[11.5px] before:top-2 before:w-px before:bg-muted-wash", className)}>
    {children}
  </ol>;
}

/** One `TraceList` row. The icon sits on the hairline, over a page-colored disc. */
export function TraceStep({ iconClassName, ...props }: Parameters<typeof TraceLine>[0]) {
  return <li className="relative min-w-0">
    <TraceLine {...props} iconClassName={cn("rounded-full bg-paper", iconClassName)} />
  </li>;
}
