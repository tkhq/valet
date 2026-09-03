// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CHAT_KEYBINDINGS,
  findMatchedBinding,
  chordParts,
  formatChord,
  isEditableTarget,
  matchChatKeybinding,
  modSymbol,
  type ChordEvent,
} from "./chat-keybindings";

function key(partial: Partial<ChordEvent> & Pick<ChordEvent, "code">): ChordEvent {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("chat-keybindings", () => {
  it("lists the chat chords in dialog order", () => {
    expect(CHAT_KEYBINDINGS.map((b) => b.id)).toEqual([
      "newThread",
      "toggleSidebar",
      "archiveThread",
      "searchThreads",
      "showShortcuts",
    ]);
  });

  it("matches every chord from the physical key it declares", () => {
    // The table's own `code` values, so a chord that can never fire (the
    // shifted-character trap) fails here instead of in the browser.
    for (const binding of CHAT_KEYBINDINGS) {
      const e = key({ code: binding.keys.code, metaKey: true, shiftKey: Boolean(binding.keys.shift) });
      expect(findMatchedBinding(e, true)?.id, `${binding.id} on Apple`).toBe(binding.id);
      const win = key({
        code: binding.keys.code,
        ctrlKey: true,
        shiftKey: Boolean(binding.keys.shift),
      });
      expect(findMatchedBinding(win, false)?.id, `${binding.id} elsewhere`).toBe(binding.id);
    }
  });

  it("matches the focus chord's neighbours without matching each other", () => {
    // `code` is the physical key, so a shifted chord matches even though
    // `key` would report the shifted character (Shift+Semicolon is ":").
    const shortcuts = CHAT_KEYBINDINGS.find((b) => b.id === "showShortcuts")!;
    expect(matchChatKeybinding(key({ code: "Slash", key: "/", metaKey: true }), shortcuts, true)).toBe(
      true,
    );
    // Shift is part of the chord, so the unshifted form must not match a
    // shifted binding and the reverse.
    const newThread = CHAT_KEYBINDINGS.find((b) => b.id === "newThread")!;
    expect(matchChatKeybinding(key({ code: "KeyO", metaKey: true }), newThread, true)).toBe(false);
  });

  it("matches a layout that reports a non-Latin key for a Latin code", () => {
    // A Cyrillic layout reports key "щ" for the physical KeyO. Matching on
    // `key` would drop the chord entirely.
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "newThread")!;
    expect(
      matchChatKeybinding(key({ code: "KeyO", key: "щ", metaKey: true, shiftKey: true }), binding, true),
    ).toBe(true);
  });

  it("falls back to key when the event carries no code", () => {
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "searchThreads")!;
    expect(matchChatKeybinding(key({ code: "", key: "k", metaKey: true }), binding, true)).toBe(true);
  });

  it("matches Mac chords on Meta and other platforms on Ctrl", () => {
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "newThread")!;
    expect(matchChatKeybinding(key({ code: "KeyO", metaKey: true, shiftKey: true }), binding, true)).toBe(true);
    expect(matchChatKeybinding(key({ code: "KeyO", ctrlKey: true, shiftKey: true }), binding, true)).toBe(false);
    const archive = CHAT_KEYBINDINGS.find((b) => b.id === "archiveThread")!;
    expect(matchChatKeybinding(key({ code: "Backspace", ctrlKey: true, shiftKey: true }), archive, false)).toBe(true);
    expect(matchChatKeybinding(key({ code: "Backspace", metaKey: true, shiftKey: true }), archive, false)).toBe(false);
  });

  it("refuses a chord carrying Alt", () => {
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "searchThreads")!;
    expect(matchChatKeybinding(key({ code: "KeyK", metaKey: true, altKey: true }), binding, true)).toBe(false);
  });

  it("formats chords for each platform", () => {
    expect(modSymbol(true)).toBe("⌘");
    expect(modSymbol(false)).toBe("Ctrl");
    expect(formatChord({ shift: true, code: "KeyO", key: "o" }, true)).toBe("⌘⇧O");
    expect(formatChord({ shift: true, code: "Backspace", key: "Backspace" }, false)).toBe(
      "Ctrl+Shift+Backspace",
    );
    expect(formatChord({ code: "Slash", key: "/" }, true)).toBe("⌘/");
    expect(chordParts({ shift: true, code: "KeyO", key: "o" }, true)).toEqual(["⌘", "⇧", "O"]);
    expect(chordParts({ code: "Slash", key: "/" }, true)).toEqual(["⌘", "/"]);
  });

  it("detects editable targets", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    // setAttribute, not the property: jsdom does not reflect
    // `contentEditable` and leaves `isContentEditable` false either way.
    editable.setAttribute("contenteditable", "true");
    const div = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
