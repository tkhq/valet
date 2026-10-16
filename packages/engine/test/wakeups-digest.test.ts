import { describe, expect, it } from "vitest";
import { boundEventDigest, cutUtf8 } from "../src/wakeups/digest.js";
import { EVENT_DIGEST_TEXT_MAX_BYTES } from "../src/wakeups/types.js";

describe("cutUtf8", () => {
  it("keeps text that fits", () => {
    expect(cutUtf8("hello", 5)).toBe("hello");
    expect(cutUtf8("", 0)).toBe("");
  });
  it("cuts ASCII at the byte limit", () => {
    expect(cutUtf8("abcdef", 4)).toBe("abcd");
  });
  it("never splits a multi-byte code point", () => {
    // "é" is 2 bytes; 5 bytes holds two of them.
    expect(cutUtf8("ééé", 5)).toBe("éé");
    // "€" is 3 bytes.
    expect(cutUtf8("a€", 3)).toBe("a");
  });
  it("never splits a surrogate pair", () => {
    // U+1F600 is 4 bytes in UTF-8 and two UTF-16 units.
    const face = "\u{1F600}";
    expect(cutUtf8(`a${face}`, 4)).toBe("a");
    expect(cutUtf8(`a${face}`, 5)).toBe(`a${face}`);
  });
  it("matches Buffer's byte count at the bound", () => {
    const text = `x${"é".repeat(3000)}${"\u{1F600}".repeat(10)}`;
    const cut = cutUtf8(text, 4096);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(cut)).toBeGreaterThan(4092);
    expect(text.startsWith(cut)).toBe(true);
  });
});

describe("boundEventDigest", () => {
  const base = { key: "k", subjects: ["s"], summary: "sum", occurredAt: "2026-10-15T00:00:00Z", dedupeKey: "d" };
  it("returns a digest without text unchanged", () => {
    expect(boundEventDigest(base)).toBe(base);
  });
  it("cuts text to EVENT_DIGEST_TEXT_MAX_BYTES", () => {
    const out = boundEventDigest({ ...base, text: "a".repeat(EVENT_DIGEST_TEXT_MAX_BYTES + 10) });
    expect(out.text).toHaveLength(EVENT_DIGEST_TEXT_MAX_BYTES);
    expect(out.dedupeKey).toBe("d");
  });
});
