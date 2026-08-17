import type { ReactNode } from "react";
import { Spinner } from "./spinner.js";
import { cn } from "~/lib/cn";

/**
 * The three states every query-backed list renders before it has rows.
 * One source for the spinner row, the failure line, and the empty-state
 * line, so panels don't each hand-roll the same three fragments.
 */
export function LoadingRow({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 py-4 text-sm text-muted", className)}>
      <Spinner size={14} /> {label}
    </div>
  );
}

/**
 * `role="alert"` because a query failure usually resolves after first paint:
 * the row mounts into an already-rendered page, which a screen reader does
 * not read again unless the new content is a live region.
 */
export function ErrorRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("py-4 text-sm text-danger-500", className)}>
      {children}
    </p>
  );
}

export function EmptyRow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("py-4 text-sm text-muted", className)}>{children}</p>;
}
