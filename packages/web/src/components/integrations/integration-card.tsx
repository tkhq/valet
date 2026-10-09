import { ServiceIcon } from "~/components/service-icon";

/**
 * The row parts every integration list shares (settings-redesign spec,
 * "Integrations"): one service per row, in a grouped list, with the mark,
 * name, state, and one line of description on the left and the row's
 * controls on the right. The details a row needs, such as its account or a
 * repair note, go below it.
 */
export function CardHeading({
  title,
  slug,
  description,
  state,
  meta,
  right,
}: {
  title: string;
  slug: string;
  description?: string;
  state?: React.ReactNode;
  /** One muted line under the description: who owns the connection and what it reaches. */
  meta?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ServiceIcon slug={slug} label={title} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{title}</span>
            {state}
          </div>
          {description && <p className="mt-0.5 line-clamp-1 text-xs leading-relaxed text-muted">{description}</p>}
          {meta && <p className="mt-0.5 text-xs text-muted">{meta}</p>}
        </div>
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">{right}</div>}
    </div>
  );
}

/** A list of integration rows, placed inside a settings `Section`. */
export function IntegrationList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {children}
    </ul>
  );
}

export function IntegrationCard({ children }: { children: React.ReactNode }) {
  // Trimmed at the ends: the settings `Section` group pads its own edges.
  return <li className="flex flex-col py-3.5 first:pt-0.5 last:pb-0.5">{children}</li>;
}
