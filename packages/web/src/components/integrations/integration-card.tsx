import { ServiceIcon } from "~/components/service-icon";

export function CardHeading({
  title,
  slug,
  description,
  state,
}: {
  title: string;
  slug: string;
  description?: string;
  state?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <ServiceIcon slug={slug} label={title} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{title}</span>
          {state}
        </div>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{description}</p>
        )}
      </div>
    </div>
  );
}

export function CardFooter({ meta, right }: { meta?: string | null; right?: React.ReactNode }) {
  return (
    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
      <span className="font-mono text-xs text-muted">{meta ?? ""}</span>
      {right}
    </div>
  );
}


export function IntegrationCard({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm">{children}</div>;
}
