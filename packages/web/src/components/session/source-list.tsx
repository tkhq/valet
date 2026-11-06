import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { SourceRecord } from "@valet/shared";
import { ServiceGlyph } from "~/components/service-icon";
import { SOURCE_FOLD_AFTER, sourcePresentation } from "./source-presentation";

/**
 * The items a call read, each linked to its exact place: a Slack message, a
 * file at a commit, a memory file. The id is the one the model cites, and
 * the citation control opens this call and shows the same records.
 */
export function SourceList({ sources, revealSourceId, revealKey }: {
  sources: readonly SourceRecord[];
  revealSourceId?: string;
  revealKey?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealedIndex = sources.findIndex(source => source.id === revealSourceId);
  useEffect(() => {
    if (revealKey !== undefined && revealedIndex >= SOURCE_FOLD_AFTER) setExpanded(true);
  }, [revealedIndex, revealKey]);
  if (sources.length === 0) return null;
  const folded = !expanded && sources.length > SOURCE_FOLD_AFTER;
  const shown = folded ? sources.slice(0, SOURCE_FOLD_AFTER) : sources;
  return <div className="mb-2">
  <ul aria-label="Sources" className="space-y-1.5 text-[13px] leading-5">
    {shown.map(source => {
      const display = sourcePresentation(source);
      return <li key={source.id} data-source-id={source.id} className="flex min-w-0 items-start gap-2">
      <span aria-hidden className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
        <ServiceGlyph service={source.service} fallback={<FileText />} />
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {source.url
          // An app path stays in this tab; a link to another site opens a new one.
          ? <a href={source.url} {...(source.url.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink">{display.title}</a>
          : <span className="text-ink">{display.title}</span>}
        <span className="ml-1.5 font-mono text-[11px] text-muted">{source.id}</span>
        {display.location && <span className="block text-xs text-muted">{display.location}</span>}
        {display.excerpt && <span className="line-clamp-2 text-xs text-muted">{display.excerpt}</span>}
      </span>
    </li>; })}
  </ul>
  {sources.length > SOURCE_FOLD_AFTER && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(open => !open)}
    className="mt-1.5 text-xs text-muted hover:text-ink hover:underline">
    {expanded ? "Show fewer sources" : `Show ${sources.length - SOURCE_FOLD_AFTER} more ${sources.length - SOURCE_FOLD_AFTER === 1 ? "source" : "sources"}`}
  </button>}
  </div>;
}
