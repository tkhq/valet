import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBrowserFrame } from "./browser-frame.js";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const frame = {
  data: bytes.toString("base64"), bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/jpeg",
  tabId: "tab", documentId: "doc", viewport: { width: 1280, height: 800 },
};
describe("inline browser frame", () => {
  it("decodes a bounded JPEG with matching identity and integrity", () => {
    expect(decodeBrowserFrame(frame, "tab").data).toEqual(bytes);
  });
  it.each([
    { ...frame, tabId: "other" }, { ...frame, documentId: "" },
    { ...frame, sha256: "bad" }, { ...frame, bytes: 700_001 },
    { ...frame, bytes: bytes.length - 1 }, { ...frame, data: frame.data + "!" },
    { ...frame, mimeType: "image/png" }, { ...frame, viewport: {width: 0, height: 800} },
    { ...frame, data: Buffer.from("not jpeg!").toString("base64"), sha256: createHash("sha256").update("not jpeg!").digest("hex") },
    null,
  ])("rejects malformed, changed, or corrupt frames", (value) => {
    expect(() => decodeBrowserFrame(value, "tab")).toThrow(/frame.*retry|frame.*image/i);
  });
  it("preserves valid cursor metadata and drops malformed display metadata", () => {
    const cursor = { x: 20, y: 30, kind: "click", sequence: 4, ageMs: 10 };
    expect(decodeBrowserFrame({ ...frame, agentCursor: cursor }, "tab").agentCursor).toEqual(cursor);
    for (const agentCursor of [null, { ...cursor, x: -1 }, { ...cursor, y: 800 },
      { ...cursor, kind: "script" }, { ...cursor, sequence: Infinity }, { ...cursor, ageMs: 3000 }]) {
      const decoded = decodeBrowserFrame({ ...frame, agentCursor }, "tab");
      expect(decoded.agentCursor).toBeUndefined();
      expect(decoded.data).toEqual(bytes);
    }
  });

});
