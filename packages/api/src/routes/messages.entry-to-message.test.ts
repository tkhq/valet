/**
 * Wire projection of engine `MessageEntry.attachments`. See
 * `entryToMessage` in ./messages.ts and `PromptImageAttachment` in
 * ../wire/types.ts.
 *
 * The engine holds attachments as either a `data:` URL (the format the
 * REST route accepts today) or raw bytes; the wire ships one canonical
 * `data:` URL string. Assistant/tool/system messages never carry
 * attachments — the field is dropped for those.
 */
import { describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { entryToMessage } from "./messages.js";

function baseEntry(overrides: Partial<MessageEntry> = {}): MessageEntry {
  return {
    id: "e_1",
    type: "message",
    role: "user",
    content: "look at this",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as MessageEntry;
}

describe("entryToMessage — attachments projection", () => {
  it("passes through a data: URL attachment unchanged", () => {
    const entry = baseEntry({
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "screenshot.png",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toEqual([
      { kind: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png", name: "screenshot.png" },
    ]);
  });

  it("synthesizes a data: URL from raw bytes", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entry = baseEntry({
      attachments: [
        { type: "image", data: bytes, mimeType: "image/png", name: "raw.png" },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    const b64 = Buffer.from(bytes).toString("base64");
    expect(msg?.attachments).toEqual([
      { kind: "image", url: `data:image/png;base64,${b64}`, mimeType: "image/png", name: "raw.png" },
    ]);
  });

  it("defaults name to 'image' when the engine entry has none", () => {
    const entry = baseEntry({
      attachments: [
        { type: "image", url: "data:image/jpeg;base64,ZZZ", mimeType: "image/jpeg" },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments?.[0].name).toBe("image");
  });

  it("skips attachments with neither url nor data", () => {
    const entry = baseEntry({
      attachments: [
        { type: "image", mimeType: "image/png", name: "empty.png" },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "good.png",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].name).toBe("good.png");
  });

  it("omits attachments entirely when the entry has none", () => {
    const msg = entryToMessage(baseEntry(), "sess", "th");
    expect(msg).not.toBeNull();
    expect(msg && "attachments" in msg).toBe(false);
  });

  it("omits attachments when every engine attachment was skipped", () => {
    const entry = baseEntry({
      attachments: [{ type: "image", mimeType: "image/png", name: "empty.png" }],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg && "attachments" in msg).toBe(false);
  });
});
