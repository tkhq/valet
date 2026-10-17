import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyRow, pageClass } from "~/components/primitives";

/** The tab pages a detail page returns to. */
export type PresenceListPath = "/presence" | "/presence/activity" | "/presence/workflows" | "/presence/runs";

/**
 * A placeholder body for a Presence page that a later change fills. It names
 * the page so a reader knows where they are.
 */
export function PresencePlaceholder({ children }: { children: ReactNode }) {
  return <EmptyRow>{children}</EmptyRow>;
}

/** A Presence detail page: a link back to its tab, a title, and a body. */
export function PresenceDetailPage({
  back,
  backLabel,
  title,
  children,
}: {
  back: PresenceListPath;
  backLabel: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <Link to={back} className="inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0">
          ← {backLabel}
        </Link>
        <h1 className="mt-2 break-words font-display text-2xl text-ink">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
