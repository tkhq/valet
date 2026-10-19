import { useId, useState } from "react";
import { Markdown, type MemoryLinkHandling } from "~/components/markdown";
import { TabBar, tabPanelId } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { DiffView } from "./diff-view";
import { TruncatedText } from "./tool-shell";

/**
 * Markdown-aware bodies for tool renderers. Memory files are markdown, so
 * mem_read/mem_write show a rendered document by default with a toggle
 * back to source; diff-producing tools (mem_patch, edit on *.md paths)
 * offer a rendered preview of the new content next to the diff.
 *
 * `memoryLinks` (optional, mem_* renderers only) makes cross-references
 * between memory files resolve against the rendered file's own path and
 * navigate via the caller's handler — without it, a relative target like
 * `../people/alice.md` renders as an external link to a dead tab. The
 * sandbox file tools (`edit`/`write` on *.md paths) must NOT pass it:
 * those render workspace files, not memory files.
 */

export function isMarkdownPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".md") || p.endsWith(".markdown");
}

/** Collapse rendered markdown taller than this until the user expands it. */
const CLAMP_LINES = 40;

const DOCUMENT_TABS = [{ id: "rendered", label: "Rendered" }, { id: "source", label: "Source" }] as const;
const DIFF_TABS = [{ id: "diff", label: "Diff" }, { id: "preview", label: "Preview" }] as const;

function ClampedMarkdown({ text, memoryLinks }: { text: string; memoryLinks?: MemoryLinkHandling }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = text.split("\n").length > CLAMP_LINES;
  return (
    <div className="px-3 py-2">
      <div className={cn("relative", clampable && !expanded && "max-h-80 overflow-hidden")}>
        <Markdown memoryLinks={memoryLinks}>{text}</Markdown>
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
    <div className="px-3 border-b border-line/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px] flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">{left}</div>
      {children}
    </div>
  );
}

/**
 * Markdown document body: rendered by default, toggleable to raw source.
 * `left` lands in the header strip next to the tabs (usually a PathLabel);
 * `actions` lands after the tabs (the mem_* renderers put their
 * open-in-viewer button there).
 */
export function MarkdownBody({
  text,
  left,
  actions,
  memoryLinks,
}: {
  text: string;
  left?: React.ReactNode;
  actions?: React.ReactNode;
  memoryLinks?: MemoryLinkHandling;
}) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  const id = useId();
  return (
    <>
      <ViewTabsBar left={left}>
        <TabBar label="Document view" id={id} size="sm" className="shadow-none" tabs={DOCUMENT_TABS} active={view} onSelect={setView} />
        {actions}
      </ViewTabsBar>
      <div role="tabpanel" id={tabPanelId(id, view)} aria-labelledby={`${tabPanelId(id, view)}-tab`}>
        {view === "rendered" ? (
          <ClampedMarkdown text={text} memoryLinks={memoryLinks} />
        ) : (
          <TruncatedText text={text} className="px-3 py-2" />
        )}
      </div>
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
  actions,
  memoryLinks,
}: {
  before: string;
  after: string;
  left?: React.ReactNode;
  actions?: React.ReactNode;
  memoryLinks?: MemoryLinkHandling;
}) {
  const [view, setView] = useState<"diff" | "preview">("diff");
  const id = useId();
  return (
    <>
      <ViewTabsBar left={left}>
        <TabBar label="Change view" id={id} size="sm" className="shadow-none" tabs={DIFF_TABS} active={view} onSelect={setView} />
        {actions}
      </ViewTabsBar>
      <div role="tabpanel" id={tabPanelId(id, view)} aria-labelledby={`${tabPanelId(id, view)}-tab`}>
        {view === "diff" ? (
          <DiffView before={before} after={after} />
        ) : (
          <ClampedMarkdown text={after} memoryLinks={memoryLinks} />
        )}
      </div>
    </>
  );
}
