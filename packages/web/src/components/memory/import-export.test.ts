import { describe, expect, it } from "vitest";
import { parseBundle, summarizeImport } from "./import-export";

describe("parseBundle", () => {
  it("accepts a V1 bundle (files map of strings, source tag)", () => {
    const text = JSON.stringify({
      format: "valet-memory-bundle@1",
      source: "v1",
      files: { "notes/a.md": "# A", "journal/2026-07-31.md": "did things" },
    });
    const b = parseBundle(text);
    expect(b.fileCount).toBe(2);
    expect(b.source).toBe("v1");
    expect(b.files["notes/a.md"]).toBe("# A");
  });

  it("accepts the raw V2 export response (manifest entries with content+hash)", () => {
    const text = JSON.stringify({
      files: { "notes/a.md": { content: "# A", hash: "abc" } },
    });
    const b = parseBundle(text);
    expect(b.fileCount).toBe(1);
    expect(b.source).toBeNull();
    expect(b.files["notes/a.md"]).toEqual({ content: "# A" });
  });

  it("accepts a bare path→content map", () => {
    const b = parseBundle(JSON.stringify({ "a.md": "hello" }));
    expect(b.fileCount).toBe(1);
    expect(b.files["a.md"]).toBe("hello");
  });

  it("rejects non-JSON with an actionable message", () => {
    expect(() => parseBundle("not json")).toThrow(/Choose a Valet memory bundle/);
  });

  it("rejects arrays and non-object files", () => {
    expect(() => parseBundle("[1,2]")).toThrow(/files/);
    expect(() => parseBundle(JSON.stringify({ files: "nope" }))).toThrow(/files/);
  });

  it("rejects a non-text entry, naming the path", () => {
    expect(() => parseBundle(JSON.stringify({ files: { "a.md": 42 } }))).toThrow(/'a\.md'/);
  });

  it("rejects an empty bundle", () => {
    expect(() => parseBundle(JSON.stringify({ files: {} }))).toThrow(/no files/);
  });

  it("a literal __proto__ key cannot pollute Object.prototype", () => {
    const b = parseBundle('{"files":{"__proto__":"evil","a.md":"ok"}}');
    expect(b.fileCount).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The key survives as plain data on the null-prototype accumulator.
    expect(Object.keys(b.files)).toContain("__proto__");
    expect(({} as { __proto__?: unknown }).__proto__).toBe(Object.prototype);
  });
});

describe("summarizeImport", () => {
  it("shows only imported when nothing was skipped or remapped", () => {
    expect(
      summarizeImport({ imported: ["a", "b"], skipped: [], remapped: [], warnings: [] }),
    ).toBe("Imported 2");
  });

  it("appends skipped and remapped counts when present", () => {
    expect(
      summarizeImport({
        imported: ["a"],
        skipped: [{ path: "index.md", reason: "auto-generated" }],
        remapped: [{ from: "lib/x.md", to: "imported-lib/x.md" }],
        warnings: [],
      }),
    ).toBe("Imported 1 · skipped 1 · remapped 1");
  });
});
