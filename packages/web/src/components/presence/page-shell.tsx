import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { AppPath } from "~/components/primitives";

/** One step of a detail page's breadcrumb. The last step names the page and
 * has no `to`. Every detail page's first step is `Presence`, a link to the
 * overview. `hash` lands the link on an anchor, such as `schedule` for the
 * overview's `On a schedule` group. */
export interface PresenceCrumb {
  label: string;
  to?: AppPath;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  hash?: string;
}

/** The first crumb of every Presence detail page. */
export const PRESENCE_CRUMB: PresenceCrumb = { label: "Presence", to: "/presence" };

/**
 * A Presence detail page: a breadcrumb, a title (the page's `h1`), an
 * optional line under the title, and a body. The section layout owns the
 * page frame. It shows the `Presence` title only on the overview, so on a
 * detail page the breadcrumb's first crumb names the section
 * (docs/specs/2026-10-16-presence-hub-design.md Part A step 2).
 */
export function PresenceDetailPage({
  crumbs,
  title,
  subtitle,
  children,
}: {
  crumbs: readonly PresenceCrumb[];
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <Breadcrumb crumbs={crumbs} />
      <h1 className="mt-2 break-words font-display text-2xl text-ink">{title}</h1>
      {subtitle !== undefined && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function Breadcrumb({ crumbs }: { crumbs: readonly PresenceCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-muted">
      <ol className="flex flex-wrap items-center">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${index}:${crumb.label}`}>
            {index > 0 && <li aria-hidden className="px-1">›</li>}
            <li className="min-w-0 break-words">
              {crumb.to !== undefined
                ? (
                  <Link
                    to={crumb.to}
                    params={crumb.params}
                    search={crumb.search}
                    hash={crumb.hash}
                    className="inline-flex min-h-11 items-center hover:text-ink sm:min-h-0"
                  >
                    {crumb.label}
                  </Link>
                )
                : <span aria-current="page">{crumb.label}</span>}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
