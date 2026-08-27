import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes.js";

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
  });

  it("formats kilobytes with one decimal, dropping .0", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5120)).toBe("5 KB");
    expect(formatBytes(843 * 1024)).toBe("843 KB");
  });

  it("formats megabytes with one decimal, dropping .0", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});
