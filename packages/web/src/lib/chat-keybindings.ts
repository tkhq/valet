/**
 * Chat keyboard shortcuts.
 *
 *   ⌘/Ctrl+Shift+O  new thread
 *   ⌘/Ctrl+Shift+S  toggle sidebar
 *   ⌘/Ctrl+Shift+⌫  archive the current thread
 *   ⌘/Ctrl+K        search threads
 *   ⌘/Ctrl+/        show this list
 *
 * The last two match claude.ai. The first two follow the convention every
 * chat client shares. Two more chords were proposed and are deliberately
 * absent: a focus-the-composer chord, because ⌘⇧; reports ":" once Shift is
 * held and so could never fire, and a copy-last-response chord, because
 * ⌘⇧C opens the element inspector in Chrome, Edge and Firefox and the page
 * never receives it. Enter, Shift+Enter and Esc already live in the
 * composer.
 *
 * Chords match on `KeyboardEvent.code`, the physical key. Matching on `key`
 * breaks twice over: a shifted character is not the unshifted one, and a
 * non-Latin layout reports a letter this table does not contain.
 */

export type ChatKeybindingId =
  | "newThread"
  | "toggleSidebar"
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
    /** `KeyboardEvent.code`: the physical key, independent of layout. */
    code: string;
    /** Display text, and the fallback for an event carrying no `code`. */
    key: string;
  };
}

/** The chat shortcut table. Order is dialog display order. */
export const CHAT_KEYBINDINGS: readonly ChatKeybinding[] = [
  { id: "newThread", label: "New thread", keys: { shift: true, code: "KeyO", key: "o" } },
  { id: "toggleSidebar", label: "Toggle sidebar", keys: { shift: true, code: "KeyS", key: "s" } },
  {
    id: "archiveThread",
    label: "Archive current thread",
    keys: { shift: true, code: "Backspace", key: "Backspace" },
  },
  { id: "searchThreads", label: "Search threads", keys: { code: "KeyK", key: "k" } },
  { id: "showShortcuts", label: "Keyboard shortcuts", keys: { code: "Slash", key: "/" } },
] as const;

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Mac OS/i.test(navigator.userAgent);
}

/** Platform modifier glyph for hints and the shortcuts dialog. */
export function modSymbol(apple = isApplePlatform()): string {
  return apple ? "⌘" : "Ctrl";
}

/** One glyph or word per key, for the shortcuts dialog's keycaps. */
export function chordParts(keys: ChatKeybinding["keys"], apple = isApplePlatform()): string[] {
  const parts: string[] = [modSymbol(apple)];
  if (keys.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(displayKey(keys.key, apple));
  return parts;
}

/** Compact chord string, e.g. `⌘⇧O` on Mac or `Ctrl+Shift+O` elsewhere. */
export function formatChord(keys: ChatKeybinding["keys"], apple = isApplePlatform()): string {
  const parts = chordParts(keys, apple);
  return apple ? parts.join("") : parts.join("+");
}

function displayKey(key: string, apple: boolean): string {
  if (key === "Backspace") return apple ? "⌫" : "Backspace";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * True when the event target takes text. The destructive chord refuses to
 * fire here: archiving the thread somebody is typing into, with no
 * confirmation, is not a shortcut anyone asked for.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // `isContentEditable` is the right API and is unimplemented in jsdom, so
  // the attribute is read too. Both spellings the HTML spec allows for the
  // enabled state count; "false" and "inherit" do not.
  const attr = target.getAttribute("contenteditable");
  if (attr === "" || attr === "true" || attr === "plaintext-only") return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The subset of a keyboard event a chord match reads. */
export type ChordEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/**
 * Match a keydown against one chord. Meta on Apple, Ctrl elsewhere, and the
 * opposite modifier must be absent so Ctrl+Cmd+K matches nothing.
 */
export function matchChatKeybinding(
  e: ChordEvent,
  binding: ChatKeybinding,
  apple = isApplePlatform(),
): boolean {
  const modPressed = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!modPressed || e.altKey) return false;
  if (Boolean(binding.keys.shift) !== e.shiftKey) return false;
  // `code` is the physical key and is what the table declares. `key` is the
  // fallback for an event that carries no code, which is what jsdom and some
  // synthetic events produce.
  if (e.code) return e.code === binding.keys.code;
  return keysEqual(e.key, binding.keys.key);
}

function keysEqual(eventKey: string, expected: string): boolean {
  if (expected.length === 1) return eventKey.toLowerCase() === expected.toLowerCase();
  return eventKey === expected;
}

export function findMatchedBinding(
  e: ChordEvent,
  apple = isApplePlatform(),
): ChatKeybinding | undefined {
  return CHAT_KEYBINDINGS.find((b) => matchChatKeybinding(e, b, apple));
}
