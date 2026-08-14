import { describe, expect, it } from "vitest";
import { pickRenderer } from "./index";
import { isMarkdownPath } from "./markdown-view";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown, case-insensitively", () => {
    expect(isMarkdownPath("journal/2026-08-14.md")).toBe(true);
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("notes.markdown")).toBe(true);
  });

  it("rejects other extensions and directories", () => {
    expect(isMarkdownPath("src/index.ts")).toBe(false);
    expect(isMarkdownPath("journal/")).toBe(false);
    expect(isMarkdownPath("")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});

describe("pickRenderer routing for memory tools", () => {
  it("routes mem_read and mem_write to their dedicated renderers", () => {
    expect(pickRenderer("mem_read").matches).toBe("mem_read");
    expect(pickRenderer("mem_write").matches).toBe("mem_write");
  });
});
