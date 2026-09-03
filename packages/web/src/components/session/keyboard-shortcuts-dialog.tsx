import { Dialog, DialogContent } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { CHAT_KEYBINDINGS, chordParts } from "~/lib/chat-keybindings";

/**
 * The "show all shortcuts" panel (⌘/Ctrl+/). Lists the chat chords the
 * global listener honors. Enter, Shift+Enter and Esc are documented here
 * too, even though the composer owns them rather than the listener.
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
      <DialogContent title="Keyboard shortcuts" description="Chat shortcuts.">
        <ul className="grid gap-2.5 text-sm">
          {CHAT_KEYBINDINGS.map((b) => (
            <ShortcutRow key={b.id} label={b.label} keys={chordParts(b.keys)} />
          ))}
          <ShortcutRow label="Send message" keys={["Enter"]} divider />
          <ShortcutRow label="New line" keys={["Shift", "Enter"]} />
          <ShortcutRow label="Stop generation" keys={["Esc"]} />
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({
  label,
  keys,
  divider,
}: {
  label: string;
  keys: readonly string[];
  divider?: boolean;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4",
        divider && "mt-1 border-t border-line pt-3",
      )}
    >
      <span className="text-ink">{label}</span>
      <span className="flex items-center justify-end gap-1">
        {keys.map((key) => (
          <KeyCap key={key}>{key}</KeyCap>
        ))}
      </span>
    </li>
  );
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-line bg-ink-wash px-1.5 font-mono text-xs leading-none text-ink">
      {children}
    </kbd>
  );
}
