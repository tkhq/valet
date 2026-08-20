import { Dialog, DialogContent } from "~/components/primitives";
import { CHAT_KEYBINDINGS, formatChord } from "~/lib/chat-keybindings";

/**
 * Claude-style "show all shortcuts" panel (⌘/Ctrl+/). Lists the chat
 * chords Valet honors; Enter / Shift+Enter / Esc stay documented too even
 * though they live in the composer rather than the global listener.
 */
export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" description="Chat shortcuts, aligned with Claude.">
        <ul className="grid gap-2 text-sm">
          {CHAT_KEYBINDINGS.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-4">
              <span className="text-ink">{b.label}</span>
              <kbd className="shrink-0 rounded border border-line bg-ink-wash/40 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {formatChord(b.keys)}
              </kbd>
            </li>
          ))}
          <li className="flex items-center justify-between gap-4 border-t border-line/60 pt-2">
            <span className="text-ink">Send message</span>
            <kbd className="shrink-0 rounded border border-line bg-ink-wash/40 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              Enter
            </kbd>
          </li>
          <li className="flex items-center justify-between gap-4">
            <span className="text-ink">New line</span>
            <kbd className="shrink-0 rounded border border-line bg-ink-wash/40 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              Shift+Enter
            </kbd>
          </li>
          <li className="flex items-center justify-between gap-4">
            <span className="text-ink">Stop generation</span>
            <kbd className="shrink-0 rounded border border-line bg-ink-wash/40 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              Esc
            </kbd>
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
