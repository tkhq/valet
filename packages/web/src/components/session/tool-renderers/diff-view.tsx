import { diffLines } from "diff";
import { Fragment, useState } from "react";
import { DiffLine } from "./write";

/**
 * Computed line diff shared by every renderer whose tool args carry a
 * before/after text pair (edit, mem_patch, …). `computeDiffRows` is the
 * pure core — it turns two strings into renderable rows with unchanged
 * runs collapsed — and `DiffView` renders those rows with the existing
 * `DiffLine` primitives.
 */

export type DiffRow =
  | { kind: "add" | "remove" | "context"; line: string }
  | { kind: "gap"; lines: string[] };

/** Lines of unchanged context kept on each side of a change. */
const CONTEXT_LINES = 3;
/** Collapse an unchanged run only when it hides more lines than this. */
const MIN_GAP = 2;

/**
 * `stripTrailingCr` keeps CRLF input from leaving a literal `\r` on each
 * line (a `\r` inside `<pre>` garbles the row). `ignoreNewlineAtEof` stops
 * a trailing-newline-only difference from rendering as a phantom
 * remove/add pair of visually identical lines.
 */
const DIFF_OPTIONS = { ignoreNewlineAtEof: true, stripTrailingCr: true } as const;

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  // A change value ends with "\n" unless it's the file's last line; drop
  // the empty trailing element so it doesn't render as a phantom line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Diff `before` → `after` line-by-line and collapse long unchanged runs
 * into `gap` rows. Leading/trailing runs keep only the context that touches
 * a change; interior runs keep `context` lines on both ends.
 */
export function computeDiffRows(
  before: string,
  after: string,
  context = CONTEXT_LINES,
): DiffRow[] {
  const flat: Array<{ kind: "add" | "remove" | "context"; line: string }> = [];
  for (const change of diffLines(before, after, DIFF_OPTIONS)) {
    const kind = change.added ? "add" : change.removed ? "remove" : "context";
    for (const line of splitLines(change.value)) flat.push({ kind, line });
  }

  const rows: DiffRow[] = [];
  let i = 0;
  while (i < flat.length) {
    if (flat[i].kind !== "context") {
      rows.push(flat[i]);
      i++;
      continue;
    }
    // Gather the whole unchanged run.
    let j = i;
    while (j < flat.length && flat[j].kind === "context") j++;
    const run = flat.slice(i, j).map((r) => r.line);
    const isLeading = i === 0;
    const isTrailing = j === flat.length;
    // The gap is the run minus the context kept on each edge that touches a
    // change. `hidden > MIN_GAP` implies gapStart < gapEnd, which keeps all
    // three slices below well-formed by construction, not by accident.
    const gapStart = isLeading ? 0 : context;
    const gapEnd = run.length - (isTrailing ? 0 : context);
    const hidden = gapEnd - gapStart;
    if (hidden > MIN_GAP) {
      for (const line of run.slice(0, gapStart)) rows.push({ kind: "context", line });
      rows.push({ kind: "gap", lines: run.slice(gapStart, gapEnd) });
      for (const line of run.slice(gapEnd)) rows.push({ kind: "context", line });
    } else {
      for (const line of run) rows.push({ kind: "context", line });
    }
    i = j;
  }
  return rows;
}

/** Added/removed line counts for header summaries ("−3 +7"). */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(before, after, DIFF_OPTIONS)) {
    const n = splitLines(change.value).length;
    if (change.added) added += n;
    else if (change.removed) removed += n;
  }
  return { added, removed };
}

export function formatDiffStats(before: string, after: string): string {
  const { added, removed } = diffStats(before, after);
  if (removed === 0) return `+${added}`;
  if (added === 0) return `−${removed}`;
  return `−${removed} +${added}`;
}

/**
 * GitHub-style unified diff. Unchanged runs longer than the context window
 * collapse into a "⋯ N unchanged lines" separator; click it to expand that
 * run in place.
 */
export function DiffView({ before, after }: { before: string; after: string }) {
  const rows = computeDiffRows(before, after);
  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<number>>(new Set());

  return (
    <div className="font-mono text-[12px] leading-[1.55] py-1">
      {/* Not a <pre>: the rows are divs and the gap is a button, neither of
          which is valid inside <pre>. whitespace-pre keeps the layout. */}
      <div className="whitespace-pre overflow-x-auto">
        {rows.map((row, i) => {
          if (row.kind !== "gap") {
            return <DiffLine key={i} kind={row.kind} line={row.line} />;
          }
          if (expandedGaps.has(i)) {
            return (
              <Fragment key={i}>
                {row.lines.map((line, k) => (
                  <DiffLine key={k} kind="context" line={line} />
                ))}
              </Fragment>
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => setExpandedGaps((prev) => new Set(prev).add(i))}
              className="flex w-full items-center gap-2 pl-2 py-0.5 text-[11px] text-muted/70 hover:text-[--fg] hover:bg-ink-wash text-left select-none"
            >
              <span aria-hidden className="w-5 shrink-0 text-center">⋯</span>
              {row.lines.length} unchanged {row.lines.length === 1 ? "line" : "lines"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
