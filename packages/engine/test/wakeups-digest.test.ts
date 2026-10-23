import { describe, expect, it } from "vitest";
import { boundEventDigest, cutUtf8, stripNul } from "../src/wakeups/digest.js";
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
  it("keeps a digest that needs no change equal to its input", () => {
    expect(boundEventDigest(base)).toEqual(base);
  });
  it("strips NUL from every string field, then cuts text", () => {
    const out = boundEventDigest({ ...base, key: "k\u0000", summary: "s\u0000um", subjects: ["a\u0000"], dedupeKey: "d\u0000", actor: "\u0000ada", text: "x\u0000y" });
    expect(out).toEqual({ ...base, key: "k", summary: "sum", subjects: ["a"], dedupeKey: "d", actor: "ada", text: "xy" });
  });
  it("strips NUL from internal producer refs", () => {
    expect(boundEventDigest({ ...base, refs: { "child_session_id\u0000": "child-1\u0000" } }).refs)
      .toEqual({ child_session_id: "child-1" });
  });
  it("cuts text to EVENT_DIGEST_TEXT_MAX_BYTES", () => {
    const out = boundEventDigest({ ...base, text: "a".repeat(EVENT_DIGEST_TEXT_MAX_BYTES + 10) });
    expect(out.text).toHaveLength(EVENT_DIGEST_TEXT_MAX_BYTES);
    expect(out.dedupeKey).toBe("d");
  });
});

describe("stripNul", () => {
  it("copies nested event payloads and strips string values and keys without changing scalar types", () => {
    const input = { "nul\u0000key": [null, true, 42, { reason: "watching\u0000build" }], text: "done\u0000" };
    expect(stripNul(input)).toEqual({ nulkey: [null, true, 42, { reason: "watchingbuild" }], text: "done" });
    expect(input.text).toBe("done\u0000");
    expect(input["nul\u0000key"][3]).toEqual({ reason: "watching\u0000build" });
    expect(stripNul("a\\u0000b")).toBe("a\\u0000b");
  });
});

it("removes lone UTF-16 surrogates recursively but keeps whole astral characters", () => {
  expect(stripNul({ "bad\ud800key": ["a\ud800b\udc00c", "😀"], text: "\u0000\udfff" }))
    .toEqual({ badkey: ["abc", "😀"], text: "" });
});
