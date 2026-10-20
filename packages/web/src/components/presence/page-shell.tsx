import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyRow, textLinkClass, type AppPath } from "~/components/primitives";

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
  titleContent,
  mark,
  subtitle,
  children,
}: {
  crumbs: readonly PresenceCrumb[];
  /** The title as text: the breadcrumb and the heading's name read it. */
  title: string;
  /** The title as it shows, such as a sentence with tokens. Absent shows
   * `title`. The heading keeps `title` as its accessible name. */
  titleContent?: ReactNode;
  /** A mark before the title, such as the place's service mark. */
  mark?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <Breadcrumb crumbs={crumbs} />
      {mark !== undefined
        ? (
          <div className="mt-2 flex items-start gap-2.5">
            {mark}
            <h1 aria-label={titleContent !== undefined ? title : undefined} className="min-w-0 break-words font-display text-2xl text-ink">{titleContent ?? title}</h1>
          </div>
        )
        : <h1 aria-label={titleContent !== undefined ? title : undefined} className="mt-2 break-words font-display text-2xl text-ink">{titleContent ?? title}</h1>}
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

/** A line's or a routine's page when the list does not hold it. */
export function MissingPage() {
  return (
    <EmptyRow>
      This page does not exist, or you cannot see it.{" "}
      <Link to="/presence" className={textLinkClass}>Back to Presence</Link>
    </EmptyRow>
  );
}
