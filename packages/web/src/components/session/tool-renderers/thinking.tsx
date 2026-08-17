import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "~/components/markdown";

/**
 * A model's `thinking` message part — reasoning content the engine now
 * forwards on the wire (previously dropped; see `bridge.ts`). Collapsed by
 * default, same disclosure interaction as `CheckpointList`/`EventRow`: this
 * is context for someone who wants it, not something to read by default in
 * a dense chat transcript.
 *
 * No elapsed-time label ("Thought for 4s") — the engine part carries only
 * text, no duration, and a fabricated number would be worse than none.
 */
export function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="rounded-md border border-line bg-[--bg]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted hover:text-ink"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        Thinking
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2 text-sm text-muted">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
