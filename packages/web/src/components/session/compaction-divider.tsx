import { useState } from "react";
import { ChevronDown, ChevronRight, FoldVertical } from "lucide-react";
import type { StreamMessage } from "~/stores/stream";
import { Markdown } from "~/components/markdown";
import { formatTokens } from "~/lib/format-usage";

/**
 * Divider row for a compaction boundary (a wire message with `compaction`).
 * Everything above it was summarized into `summary`; the divider shows the
 * token delta and expands to the summary text on click.
 */
export function CompactionDivider({ message }: { message: StreamMessage }) {
  const [open, setOpen] = useState(false);
  const c = message.compaction;
  if (!c) return null;
  const before = formatTokens(c.tokensBefore);
  const after = formatTokens(c.tokensAfter);
  return (
    <div className="px-4 py-2" data-testid="compaction-divider">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-[11px] text-muted hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 rounded"
      >
        <span className="h-px flex-1 bg-[--border]" aria-hidden />
        <FoldVertical className="h-3 w-3 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">
          Context compacted · {before} → {after} tokens
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="h-px flex-1 bg-[--border]" aria-hidden />
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-[--border] bg-[--bg-secondary] px-3 py-2 text-xs">
          <Markdown>{c.summary}</Markdown>
        </div>
      )}
    </div>
  );
}
