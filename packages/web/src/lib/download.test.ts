import { describe, expect, it } from "vitest";
import { artifactDownloadName, memoryDownloadName } from "./download";

describe("memoryDownloadName", () => {
  it("uses the path basename", () => {
    expect(memoryDownloadName("journal/2026-07-13.md")).toBe("2026-07-13.md");
    expect(memoryDownloadName("people/alice.md")).toBe("alice.md");
  });

  it("appends .md when the basename has no extension", () => {
    expect(memoryDownloadName("notes/scratch")).toBe("scratch.md");
  });

  it("falls back for an empty path", () => {
    expect(memoryDownloadName("")).toBe("memory.md");
  });
});

describe("artifactDownloadName", () => {
  it("slugs a free-text title", () => {
    expect(artifactDownloadName("Q3 Roadmap: Draft!")).toBe("q3-roadmap-draft.md");
  });

  it("falls back when the title has no usable characters", () => {
    expect(artifactDownloadName("???")).toBe("artifact.md");
  });
});
