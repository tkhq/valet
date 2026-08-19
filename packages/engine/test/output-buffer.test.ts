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
});
