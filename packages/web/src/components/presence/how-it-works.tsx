/**
 * How it works on a line's page and a routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part D step 1.6, Part E
 * step 2): three columns, **When**, **Do**, **Where**. Each column shows its
 * value in words with tokens, one sentence that explains the behavior, and
 * a `Change` link that opens the editor on that section. For a viewer who
 * may not change the line, each `Change` is disabled.
 */
import { useId } from "react";
import { cn } from "~/lib/cn";
import { Sentence } from "./sentence";
import type { SentencePart } from "./sentences";

export type HowSection = "when" | "do" | "where";

export interface HowColumn {
  section: HowSection;
  value: readonly SentencePart[];
  explanation: string;
}

const KEYS: Readonly<Record<HowSection, string>> = { when: "When", do: "Do", where: "Where" };

export function HowItWorks({
  columns,
  onChange,
  readOnly = false,
}: {
  columns: readonly HowColumn[];
  onChange: (section: HowSection) => void;
  readOnly?: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-[13px] font-medium text-muted">How it works</h2>
      <div className="grid gap-6 sm:grid-cols-3">
        {columns.map((column) => (
          <div key={column.section} data-section={column.section} className="min-w-0 border-l-2 border-line pl-3.5">
            <p className="mb-1 text-xs text-muted">{KEYS[column.section]}</p>
            <p className="text-base leading-snug text-ink [overflow-wrap:anywhere]"><Sentence parts={column.value} /></p>
            <p className="mt-1.5 text-xs leading-normal text-muted">{column.explanation}</p>
            <button
              type="button"
              disabled={readOnly}
              aria-label={`Change ${KEYS[column.section]}`}
              onClick={() => onChange(column.section)}
              className={cn(
                "mt-2 inline-flex min-h-11 items-center text-xs sm:min-h-0",
                readOnly ? "cursor-not-allowed text-muted" : "text-accent-600 hover:underline",
              )}
            >
              Change
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
