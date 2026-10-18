import { Link, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * The one page column: width and gutters for every list, dashboard, and
 * settings page, so their headers and cards start on the same line when a
 * reader moves between pages. Prose (memory documents) and narrow forms keep
 * their own widths.
 */
export const pageClass = "mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10";

/**
 * The top of a page: an optional back link, the title with an optional
 * clause beside it (such as `WorkspaceClause`), the page actions on the
 * right, and an optional description below.
 */
export function PageHeader({ title, clause, description, actions, back, className }: {
  title: ReactNode;
  clause?: ReactNode;
  description?: ReactNode;
  /** One element. Wrap two or more actions in a `div`, because each child is a flex item of the title row. */
  actions?: ReactNode;
  /** Usually a `BackLink`. */
  back?: ReactNode;
  className?: string;
}) {
  return (
    <header className={className}>
      {back && <div className="mb-2">{back}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words font-display text-2xl text-ink">{title}</h1>
          {clause}
        </div>
        {actions}
      </div>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
    </header>
  );
}

const BACK_LINK_CLASS = "inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0";

/**
 * A "← label" link to the parent page. It takes the props of `Link`, so the
 * route and its params stay typed.
 */
export function BackLink<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown>(
  props: ValidateLinkOptions<TRouter, TOptions> & { children: ReactNode },
): ReactNode;
export function BackLink({ className, children, ...rest }: Omit<ValidateLinkOptions, "children"> & { children: ReactNode }): ReactNode {
  return (
    <Link {...rest} className={cn(BACK_LINK_CLASS, className)}>
      ← {children}
    </Link>
  );
}
