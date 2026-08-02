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
export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  minHeight = "50vh",
  autoFocus,
  className,
}: MarkdownEditorProps) {
  return (
    <div className={cn("grid gap-3 lg:grid-cols-2", className)}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        style={{ minHeight }}
        className="w-full resize-y rounded-md border border-line bg-paper p-3 font-mono text-sm leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      />
      <div
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
