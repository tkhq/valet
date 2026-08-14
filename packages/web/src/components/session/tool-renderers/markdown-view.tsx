import { useState } from "react";
import { Markdown } from "~/components/markdown";
import { cn } from "~/lib/cn";
import { DiffView } from "./diff-view";
import { TruncatedText } from "./tool-shell";

/**
 * Markdown-aware bodies for tool renderers. Memory files are markdown, so
 * mem_read/mem_write show a rendered document by default with a toggle
 * back to source; diff-producing tools (mem_patch, edit on *.md paths)
 * offer a rendered preview of the new content next to the diff.
 */

export function isMarkdownPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".md") || p.endsWith(".markdown");
}

/** Collapse rendered markdown taller than this until the user expands it. */
const CLAMP_LINES = 40;

function ViewTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 text-[10px] font-mono uppercase tracking-wider">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          aria-pressed={value === opt}
          className={cn(
            "px-1.5 py-0.5 rounded transition-colors",
            value === opt
              ? "bg-ink-wash text-[--fg]"
              : "text-muted/70 hover:text-[--fg]",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function ClampedMarkdown({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = text.split("\n").length > CLAMP_LINES;
  return (
    <div className="px-3 py-2">
      <div className={cn("relative", clampable && !expanded && "max-h-80 overflow-hidden")}>
        <Markdown>{text}</Markdown>
        {clampable && !expanded && (
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[--bg] to-transparent"
          />
        )}
      </div>
      {clampable && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-[11px] text-muted hover:text-[--fg] underline-offset-2 hover:underline"
        >
          show all
        </button>
      )}
    </div>
  );
}

/** Header strip that carries the view tabs, right-aligned after `left`. */
export function ViewTabsBar({
  left,
  children,
}: {
  left?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px] flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">{left}</div>
      {children}
    </div>
  );
}

/**
 * Markdown document body: rendered by default, toggleable to raw source.
 * `left` lands in the header strip next to the tabs (usually a PathLabel).
 */
export function MarkdownBody({ text, left }: { text: string; left?: React.ReactNode }) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  return (
    <>
      <ViewTabsBar left={left}>
        <ViewTabs value={view} options={["rendered", "source"] as const} onChange={setView} />
      </ViewTabsBar>
      {view === "rendered" ? (
        <ClampedMarkdown text={text} />
      ) : (
        <TruncatedText text={text} className="px-3 py-2" />
      )}
    </>
  );
}

/**
 * Diff body with a rendered preview of the post-change content. The diff
 * stays the default view — the preview answers "what does the new text
 * look like", not "what changed".
 */
export function MarkdownDiffBody({
  before,
  after,
  left,
}: {
  before: string;
  after: string;
  left?: React.ReactNode;
}) {
  const [view, setView] = useState<"diff" | "preview">("diff");
  return (
    <>
      <ViewTabsBar left={left}>
        <ViewTabs value={view} options={["diff", "preview"] as const} onChange={setView} />
      </ViewTabsBar>
      {view === "diff" ? <DiffView before={before} after={after} /> : <ClampedMarkdown text={after} />}
    </>
  );
}
