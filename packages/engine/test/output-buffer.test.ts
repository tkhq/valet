/**
 * CappedOutputBuffer: the head+tail output cap shared by the sandbox
 * providers. Pins the append-only head (job-mode poll safety), the tail
 * ring, the omission marker, and the no-drop passthrough.
 */
import { describe, expect, it } from "vitest";
import { CappedOutputBuffer, omittedMarker } from "../src/sandbox/output-buffer.js";

describe("CappedOutputBuffer", () => {
  it("passes small output through untouched — no marker, not truncated", () => {
    const buf = new CappedOutputBuffer(100);
    buf.append("hello ");
    buf.append("world");
    expect(buf.value()).toBe("hello world");
    expect(buf.truncated).toBe(false);
  });

  it("keeps head and tail and marks the omitted middle", () => {
    // limit 8 → headMax 2, tailMax 6.
    const buf = new CappedOutputBuffer(8);
    buf.append("abcdefghijklmnop"); // 16 bytes: head "ab", tail last 6 "klmnop", dropped 8
    expect(buf.headText).toBe("ab");
    expect(buf.truncated).toBe(true);
    expect(buf.value()).toBe(`ab${omittedMarker(8)}klmnop`);
  });

  it("head is append-only across chunks (job-mode poll safety)", () => {
    const buf = new CappedOutputBuffer(8);
    buf.append("a");
    const h1 = buf.headText;
    buf.append("bcdefghijkl");
    expect(buf.headText.startsWith(h1)).toBe(true);
    expect(buf.headText).toBe("ab");
  });

  it("counts dropped bytes across many chunks", () => {
    const buf = new CappedOutputBuffer(8); // head 2, tail 6
    for (let i = 0; i < 10; i++) buf.append("0123456789"); // 100 bytes total
    // head 2 + tail 6 kept → 92 dropped.
    expect(buf.value()).toContain("92 bytes omitted");
    expect(buf.value().endsWith("456789")).toBe(true);
  });

  it("tail without drop joins seamlessly (output slightly over headMax)", () => {
    const buf = new CappedOutputBuffer(8); // head 2, tail 6
    buf.append("abcdefg"); // 7 bytes: head "ab", tail "cdefg", dropped 0
    expect(buf.value()).toBe("abcdefg");
    expect(buf.truncated).toBe(false);
  });

  it("uses UTF-8 bytes and keeps complete multibyte code points", () => {
    const buf = new CappedOutputBuffer(8); // head 2 bytes, tail 6 bytes
    buf.append("A🧪BC🧪Z"); // 12 bytes total

    expect(buf.headText).toBe("A");
    expect(buf.value()).toBe(`A${omittedMarker(5)}C🧪Z`);
    expect(buf.value()).not.toContain("�");
    expect(buf.truncated).toBe(true);
  });

  it("joins a surrogate pair split across appends before applying the byte cap", () => {
    const once = new CappedOutputBuffer(8);
    once.append("A🧪BC🧪Z");

    const chunked = new CappedOutputBuffer(8);
    const emoji = "🧪";
    chunked.append(`A${emoji[0]}`);
    expect(chunked.headText).toBe("A");
    chunked.append(`${emoji[1]}BC${emoji[0]}`);
    chunked.append(`${emoji[1]}Z`);

    expect(chunked.value()).toBe(once.value());
    expect(chunked.value()).not.toContain("�");
  });

  it("does not fill a skipped head gap with bytes from a later append", () => {
    const once = new CappedOutputBuffer(8);
    once.append("🧪ABCDEF");

    const chunked = new CappedOutputBuffer(8);
    chunked.append("🧪");
    chunked.append("ABCDEF");

    expect(chunked.headText).toBe("");
    expect(chunked.value()).toBe(once.value());
    expect(chunked.value()).toBe(`${omittedMarker(4)}ABCDEF`);
  });

  it("supports a zero-byte cap and reports all input bytes as omitted", () => {
    const buf = new CappedOutputBuffer(0);
    buf.append("A🧪");

    expect(buf.headText).toBe("");
    expect(buf.value()).toBe(omittedMarker(5));
    expect(buf.truncated).toBe(true);
  });

  it("normalizes finite limits and rejects non-finite limits", () => {
    const fractional = new CappedOutputBuffer(4.9);
    fractional.append("abcdefgh");
    expect(fractional.value()).toBe(`a${omittedMarker(4)}fgh`);

    const negative = new CappedOutputBuffer(-1);
    negative.append("abc");
    expect(negative.value()).toBe(omittedMarker(3));

    expect(() => new CappedOutputBuffer(Number.NaN)).toThrow(RangeError);
    expect(() => new CappedOutputBuffer(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("finalizes a dangling high surrogate into the terminal appendix", () => {
    const buf = new CappedOutputBuffer(16);
    buf.append("a\ud800");

    expect(buf.headText).toBe("a");
    expect(buf.appendix()).toBe("\ufffd");
    expect(buf.truncated).toBe(false);
    expect(buf.value()).toBe("a\ufffd");
  });

  it("counts a dangling high surrogate when the cap cannot retain it", () => {
    const tight = new CappedOutputBuffer(2);
    tight.append("\ud800");
    expect(tight.value()).toBe(omittedMarker(3));
    expect(tight.truncated).toBe(true);

    const zero = new CappedOutputBuffer(0);
    zero.append("\ud800");
    expect(zero.appendix()).toBe(omittedMarker(3));
    expect(zero.truncated).toBe(true);
  });

  it("finalizes once and rejects appends after a terminal view", () => {
    const buf = new CappedOutputBuffer(2);
    buf.append("\ud800");

    const first = buf.appendix();
    expect(buf.appendix()).toBe(first);
    expect(buf.value()).toBe(first);
    expect(() => buf.append("later")).toThrow(/finalized/);
  });
});
