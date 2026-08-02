import { useRef } from "react";
import { Markdown } from "~/components/markdown";
import { cn } from "~/lib/cn";

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Accessible name for the textarea — also what tests target. */
  ariaLabel: string;
  placeholder?: string;
  /** Shared min-height for both panes. Default suits a full-page editor. */
  minHeight?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Split-view markdown editor: plain textarea on the left, live rendered
 * preview on the right (stacked on narrow screens). Deliberately
 * dependency-free — no CodeMirror — because every current caller edits
 * prose-sized markdown, not code. Shared by the memory explorer's doc
 * editor; built as a general component because several surfaces need
 * markdown editing.
 */
/** Proportional scroll sync between two panes of different content
 * heights. Returns the target scrollTop for `dst` matching `src`'s scroll
 * ratio. Exported for tests (jsdom has no layout, so the component path
 * can't be exercised with real dimensions). */
export function syncedScrollTop(
  src: { scrollTop: number; scrollHeight: number; clientHeight: number },
  dst: { scrollHeight: number; clientHeight: number },
): number {
  const srcMax = src.scrollHeight - src.clientHeight;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  if (srcMax <= 0 || dstMax <= 0) return 0;
  return (src.scrollTop / srcMax) * dstMax;
}

export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  minHeight = "50vh",
  autoFocus,
  className,
}: MarkdownEditorProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Which pane is about to receive a PROGRAMMATIC scroll — its next scroll
  // event is an echo of the sync, not user input, and must not sync back
  // (the feedback loop makes both panes fight and judder).
  const echoPane = useRef<"editor" | "preview" | null>(null);

  function syncFrom(pane: "editor" | "preview") {
    if (echoPane.current === pane) {
      echoPane.current = null;
      return;
    }
    const src = pane === "editor" ? editorRef.current : previewRef.current;
    const dst = pane === "editor" ? previewRef.current : editorRef.current;
    if (!src || !dst) return;
    const target = syncedScrollTop(src, dst);
    if (Math.abs(dst.scrollTop - target) > 1) {
      echoPane.current = pane === "editor" ? "preview" : "editor";
      dst.scrollTop = target;
    }
  }

  return (
    <div className={cn("grid gap-3 lg:grid-cols-2", className)}>
      <textarea
        ref={editorRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={() => syncFrom("editor")}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        style={{ minHeight, maxHeight: `max(${minHeight}, 70vh)` }}
        className="w-full resize-y rounded-md border border-line bg-paper p-3 font-mono text-sm leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      />
      <div
        ref={previewRef}
        onScroll={() => syncFrom("preview")}
        style={{ minHeight, maxHeight: `max(${minHeight}, 70vh)` }}
        className="overflow-y-auto rounded-md border border-line bg-paper px-4 py-3"
        aria-label={`${ariaLabel} preview`}
      >
        {value.trim().length > 0 ? (
          <Markdown className="text-[15px]">{value}</Markdown>
        ) : (
          <p className="text-sm text-muted">Nothing to preview yet.</p>
        )}
      </div>
    </div>
  );
}
