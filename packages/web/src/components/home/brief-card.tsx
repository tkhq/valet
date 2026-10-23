import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { StatusDot } from "~/components/primitives";
import { cn } from "~/lib/cn";

export type BriefItemState = "needs_you" | "working" | "done" | "fyi";

export interface BriefItem {
  topic: string;
  text: string;
  state: BriefItemState;
  threadId?: string;
}

const DOT: Record<BriefItemState, { tone: "warning" | "info" | "neutral" | "outline"; label: string }> = {
  needs_you: { tone: "warning", label: "Needs you" },
  working: { tone: "info", label: "In progress" },
  done: { tone: "neutral", label: "Done" },
  fyi: { tone: "outline", label: "For your information" },
};

/**
 * A brief: one headline and a short list of items, each a bold topic and one
 * line. An item about a task opens it. Valet shows one each morning and when
 * the person asks what is going on.
 */
export function BriefCard({ headline, items, className }: { headline: string; items: BriefItem[]; className?: string }) {
  return <section aria-label="Brief" className={cn("min-w-0 rounded-xl border border-line bg-paper", className)}>
    <h3 className="px-4 pb-2 pt-3 font-display text-base text-ink">{headline}</h3>
    {items.length > 0 && <ul className="divide-y divide-line border-t border-line">
      {items.map((item, index) => {
        const dot = DOT[item.state];
        const body = <>
          <StatusDot tone={dot.tone} label={dot.label} className="mt-1.5" />
          <span className="min-w-0 flex-1 text-sm leading-5 text-ink [overflow-wrap:anywhere]">
            <span className="font-semibold">{item.topic}:</span> {item.text}
          </span>
          {item.threadId && <ChevronRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
        </>;
        // Items hold no state, so an index key cannot hand state to the wrong item.
        return <li key={index}>
          {item.threadId
            ? <Link to="/threads/$threadId" params={{ threadId: item.threadId }} className="flex min-w-0 items-start gap-3 px-4 py-2.5 hover:bg-ink-wash max-sm:min-h-11">{body}</Link>
            : <div className="flex min-w-0 items-start gap-3 px-4 py-2.5">{body}</div>}
        </li>;
      })}
    </ul>}
  </section>;
}
