/**
 * Chat keyboard shortcuts, modeled on claude.ai's chat bindings:
 *   ⌘/Ctrl+Shift+O  new chat
 *   ⌘/Ctrl+Shift+S  toggle sidebar
 *   ⌘/Ctrl+Shift+;  focus message input
 *   ⌘/Ctrl+Shift+C  copy last response
 *   ⌘/Ctrl+Shift+⌫  archive/delete current conversation
 *   ⌘/Ctrl+K        search
 *   ⌘/Ctrl+/        show shortcuts
 *
 * Enter / Shift+Enter / Esc already live in the composer.
 */

export type ChatKeybindingId =
  | "newThread"
  | "toggleSidebar"
  | "focusComposer"
  | "copyLastResponse"
  | "archiveThread"
  | "searchThreads"
  | "showShortcuts";

export interface ChatKeybinding {
  id: ChatKeybindingId;
  /** Human-readable action label for the shortcuts dialog. */
  label: string;
  /** Keys after the platform modifier (Meta on Apple, Ctrl elsewhere). */
  keys: {
    shift?: boolean;
    /** Lowercase letter, or a KeyboardEvent.key value like "Backspace" / ";" / "/". */
    key: string;
  };
}

/** The Claude-aligned chat shortcut table. Order is dialog display order. */
export const CHAT_KEYBINDINGS: readonly ChatKeybinding[] = [
  { id: "newThread", label: "New thread", keys: { shift: true, key: "o" } },
  { id: "toggleSidebar", label: "Toggle sidebar", keys: { shift: true, key: "s" } },
  { id: "focusComposer", label: "Focus message input", keys: { shift: true, key: ";" } },
  { id: "copyLastResponse", label: "Copy last response", keys: { shift: true, key: "c" } },
  {
    id: "archiveThread",
    label: "Archive current thread",
    keys: { shift: true, key: "Backspace" },
  },
  { id: "searchThreads", label: "Search threads", keys: { key: "k" } },
  { id: "showShortcuts", label: "Keyboard shortcuts", keys: { key: "/" } },
] as const;

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Mac OS/i.test(navigator.userAgent);
}

/** Platform modifier glyph for hints and the shortcuts dialog. */
export function modSymbol(apple = isApplePlatform()): string {
  return apple ? "⌘" : "Ctrl";
}

/** Compact chord string, e.g. `⌘⇧O` on Mac or `Ctrl+Shift+O` elsewhere. */
export function formatChord(
  keys: ChatKeybinding["keys"],
  apple = isApplePlatform(),
): string {
  const parts: string[] = [modSymbol(apple)];
  if (keys.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(displayKey(keys.key, apple));
  return apple ? parts.join("") : parts.join("+");
}

function displayKey(key: string, apple: boolean): string {
  if (key === "Backspace") return apple ? "⌫" : "Backspace";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** True when the event target is a text field — global chords still fire;
 * bare letter accelerators (menu `A`) should not. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Match a keydown against a Claude-style chord. Uses Meta on Apple and Ctrl
 * elsewhere — the same split claude.ai documents for Mac vs Windows/Linux.
 */
export function matchChatKeybinding(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  binding: ChatKeybinding,
  apple = isApplePlatform(),
): boolean {
  const modPressed = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!modPressed || e.altKey) return false;
  if (Boolean(binding.keys.shift) !== e.shiftKey) return false;
  return keysEqual(e.key, binding.keys.key);
}

function keysEqual(eventKey: string, expected: string): boolean {
  if (expected.length === 1) return eventKey.toLowerCase() === expected.toLowerCase();
  return eventKey === expected;
}

export function findMatchedBinding(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  apple = isApplePlatform(),
): ChatKeybinding | undefined {
  return CHAT_KEYBINDINGS.find((b) => matchChatKeybinding(e, b, apple));
}
