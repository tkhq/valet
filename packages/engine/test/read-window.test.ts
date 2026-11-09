import { describe, expect, it } from "vitest";
import { READ_MAX_CHARS, readWindow } from "../src/builtin-tools/index.js";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("readWindow", () => {
  it("returns a small file unchanged", () => {
    expect(readWindow("a\nb\n", 1, 2000)).toBe("a\nb\n");
  });

  it("stops at the line limit and names the next offset", () => {
    const window = readWindow(numbered(10), 1, 4);
    expect(window).toBe("line 1\nline 2\nline 3\nline 4\n[read: lines 1-4 of 10; read again with offset 5 to continue]");
  });

  it("continues from an offset to the end of the file", () => {
    expect(readWindow(numbered(10), 9, 4)).toBe("line 9\nline 10\n[read: lines 9-10 of 10; end of file]");
  });

  it("caps the characters of a long file", () => {
    const wide = Array.from({ length: 20 }, () => "x".repeat(10_000)).join("\n");
    const window = readWindow(wide, 1, 2000);
    expect(window.length).toBeLessThan(READ_MAX_CHARS + 200);
    expect(window).toMatch(/read again with offset \d+ to continue\]$/);
  });

  it("says when the offset is past the end", () => {
    expect(readWindow(numbered(3), 9, 10)).toBe("[read: line 9 is past the end of the file, which has 3 lines]");
  });
});
