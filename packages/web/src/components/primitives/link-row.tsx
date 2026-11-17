import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { AppPath } from "./link-tabs.js";

/**
 * One row of a settings overview: an icon, a title, a one-line description,
 * an optional current value on the right, and a chevron. The whole row is a
 * link to the page that holds the setting. It sits in a `Section` group.
 */
export function LinkRow({ to, params, hash, icon: Icon, title, description, value }: {
  to: AppPath;
  params?: Record<string, string>;
  /** An element id on the target page to scroll to. */
  hash?: string;
  icon: LucideIcon;
  title: string;
  description: string;
  value?: string;
}) {
  return (
    <Link to={to} params={params} hash={hash} className="group flex items-center gap-3 py-3 first:pt-0.5 last:pb-0.5">
      <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink group-hover:underline">{title}</span>
        <span className="block truncate text-xs text-muted">{description}</span>
      </span>
      {value && <span className="shrink-0 text-sm text-muted tabular-nums">{value}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted group-hover:text-ink" aria-hidden />
    </Link>
  );
}
