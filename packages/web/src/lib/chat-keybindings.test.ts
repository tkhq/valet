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
} from "./chat-keybindings";

function key(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("chat-keybindings", () => {
  it("lists the Claude-aligned chat chords", () => {
    const ids = CHAT_KEYBINDINGS.map((b) => b.id);
    expect(ids).toEqual([
      "newThread",
      "toggleSidebar",
      "focusComposer",
      "copyLastResponse",
      "archiveThread",
      "searchThreads",
      "showShortcuts",
    ]);
  });

  it("matches Mac chords on Meta (not Ctrl)", () => {
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "newThread")!;
    expect(matchChatKeybinding(key({ key: "o", metaKey: true, shiftKey: true }), binding, true)).toBe(
      true,
    );
    expect(matchChatKeybinding(key({ key: "o", ctrlKey: true, shiftKey: true }), binding, true)).toBe(
      false,
    );
  });

  it("matches Windows/Linux chords on Ctrl (not Meta)", () => {
    const binding = CHAT_KEYBINDINGS.find((b) => b.id === "archiveThread")!;
    expect(
      matchChatKeybinding(key({ key: "Backspace", ctrlKey: true, shiftKey: true }), binding, false),
    ).toBe(true);
    expect(
      matchChatKeybinding(key({ key: "Backspace", metaKey: true, shiftKey: true }), binding, false),
    ).toBe(false);
  });

  it("finds ⌘K / Ctrl+K as searchThreads", () => {
    expect(findMatchedBinding(key({ key: "k", metaKey: true }), true)?.id).toBe("searchThreads");
    expect(findMatchedBinding(key({ key: "k", ctrlKey: true }), false)?.id).toBe("searchThreads");
  });

  it("formats chords for each platform", () => {
    expect(modSymbol(true)).toBe("⌘");
    expect(modSymbol(false)).toBe("Ctrl");
    expect(formatChord({ shift: true, key: "o" }, true)).toBe("⌘⇧O");
    expect(formatChord({ shift: true, key: "Backspace" }, false)).toBe("Ctrl+Shift+Backspace");
    expect(formatChord({ key: "/" }, true)).toBe("⌘/");
    expect(chordParts({ shift: true, key: "o" }, true)).toEqual(["⌘", "⇧", "O"]);
    expect(chordParts({ key: "/" }, true)).toEqual(["⌘", "/"]);
    expect(chordParts({ shift: true, key: "Backspace" }, false)).toEqual([
      "Ctrl",
      "Shift",
      "Backspace",
    ]);
  });

  it("detects editable targets", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
  });
});
