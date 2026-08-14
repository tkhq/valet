import { describe, expect, it } from "vitest";
import { computeDiffRows, diffStats, formatDiffStats, type DiffRow } from "./diff-view";

function render(rows: DiffRow[]): string[] {
  return rows.map((r) =>
    r.kind === "gap"
      ? `⋯${r.lines.length}`
      : `${r.kind === "add" ? "+" : r.kind === "remove" ? "−" : " "}${r.line}`,
  );
}

describe("computeDiffRows", () => {
  it("interleaves unchanged lines between changes", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    expect(render(computeDiffRows(before, after))).toEqual([
      " a",
      "−b",
      "+B",
      " c",
    ]);
  });

  it("renders a creation (empty before) as all additions", () => {
    const rows = computeDiffRows("", "one\ntwo");
    expect(render(rows)).toEqual(["+one", "+two"]);
  });

  it("collapses long unchanged runs into a gap with context on both ends", () => {
    const middle = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const before = ["start", ...middle, "end"].join("\n");
    const after = ["START", ...middle, "END"].join("\n");
    const rows = computeDiffRows(before, after);
    const rendered = render(rows);
    expect(rendered.slice(0, 5)).toEqual([
      "−start",
      "+START",
      " line 0",
      " line 1",
      " line 2",
    ]);
    expect(rendered).toContain("⋯6");
    expect(rendered.slice(-5)).toEqual([
      " line 9",
      " line 10",
      " line 11",
      "−end",
      "+END",
    ]);
  });

  it("keeps only trailing context for a leading unchanged run", () => {
    const head = Array.from({ length: 10 }, (_, i) => `h${i}`);
    const before = [...head, "old"].join("\n");
    const after = [...head, "new"].join("\n");
    const rendered = render(computeDiffRows(before, after));
    expect(rendered[0]).toBe("⋯7");
    expect(rendered.slice(1)).toEqual([" h7", " h8", " h9", "−old", "+new"]);
  });

  it("keeps only leading context for a trailing unchanged run", () => {
    const tail = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const before = ["old", ...tail].join("\n");
    const after = ["new", ...tail].join("\n");
    const rendered = render(computeDiffRows(before, after));
    expect(rendered.slice(0, 5)).toEqual(["−old", "+new", " t0", " t1", " t2"]);
    expect(rendered[5]).toBe("⋯7");
  });

  it("shows short unchanged runs in full instead of a gap", () => {
    const before = "a\nx\ny\nb";
    const after = "A\nx\ny\nB";
    expect(render(computeDiffRows(before, after))).toEqual([
      "−a",
      "+A",
      " x",
      " y",
      "−b",
      "+B",
    ]);
  });

  it("does not emit a phantom line for a trailing newline", () => {
    const rows = computeDiffRows("a\n", "b\n");
    expect(render(rows)).toEqual(["−a", "+b"]);
  });

  it("ignores a trailing-newline-only difference", () => {
    // Without ignoreNewlineAtEof, jsdiff reports "b" → "b\n" as a
    // remove/add pair of visually identical lines.
    expect(render(computeDiffRows("a\nb", "a\nb\n"))).toEqual([" a", " b"]);
    expect(diffStats("a\nb", "a\nb\n")).toEqual({ added: 0, removed: 0 });
  });

  it("strips carriage returns from CRLF input", () => {
    const rows = computeDiffRows("a\r\nb\r\n", "a\r\nc\r\n");
    expect(render(rows)).toEqual([" a", "−b", "+c"]);
  });
});

describe("diffStats", () => {
  it("counts only changed lines, not context", () => {
    expect(diffStats("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("counts a creation as pure additions", () => {
    expect(diffStats("", "one\ntwo\nthree")).toEqual({ added: 3, removed: 0 });
  });
});

describe("formatDiffStats", () => {
  it("omits the zero side", () => {
    expect(formatDiffStats("", "a\nb")).toBe("+2");
    expect(formatDiffStats("a\nb", "")).toBe("−2");
    expect(formatDiffStats("a\nx", "a\ny")).toBe("−1 +1");
  });
});
