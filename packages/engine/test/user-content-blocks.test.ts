import { describe, it, expect } from "vitest";
import { userContentBlocks } from "../src/thread.js";
import type { MessageEntry } from "../src/types.js";

type Attachments = NonNullable<MessageEntry["attachments"]>;

describe("userContentBlocks", () => {
  it("returns the text unchanged when there are no attachments", () => {
    expect(userContentBlocks("hello", undefined)).toEqual([{ type: "text", text: "hello" }]);
    expect(userContentBlocks("hello", [])).toEqual([{ type: "text", text: "hello" }]);
  });

  it("prepends the file note for file attachments", () => {
    const attachments: Attachments = [
      {
        type: "file",
        path: "/workspace/uploads/data.csv",
        bytes: 2048,
        sha256: "abc",
        mimeType: "text/csv",
        name: "data.csv",
      },
    ];
    const blocks = userContentBlocks("analyze this", attachments);
    expect(blocks).toHaveLength(1);
    const [text] = blocks;
    if (text.type !== "text") throw new Error("expected text block");
    expect(text.text).toContain("[User attached files to the sandbox:");
    expect(text.text).toContain("/workspace/uploads/data.csv");
    // The user's own words follow the note.
    expect(text.text.endsWith("analyze this")).toBe(true);
  });

  it("keeps image blocks alongside the note", () => {
    const attachments: Attachments = [
      {
        type: "file",
        path: "/workspace/uploads/a.txt",
        bytes: 3,
        sha256: "abc",
        name: "a.txt",
      },
      { type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png", name: "b.png" },
    ];
    const blocks = userContentBlocks("look", attachments);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("image");
  });
});
