import { describe, expect, it } from "vitest";
import { capOutput, GENERIC_CAP_NOTE } from "./mcp-output.js";

const size = (value: unknown) => JSON.stringify(value).length;

describe("capOutput", () => {
  it("returns a small result unchanged", () => {
    const value = { tool_id: "demo.ping", status: "completed", result: { ok: true } };
    expect(capOutput(value, "note", 1_000)).toEqual(value);
  });

  it("wraps a value that is not an object", () => {
    expect(capOutput([1, 2], "note", 1_000)).toEqual({ result: [1, 2] });
    expect(capOutput("text", "note", 1_000)).toEqual({ result: "text" });
  });

  it("shortens the largest field to a JSON preview and keeps the envelope", () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, body: "x".repeat(50) })) };
    const out = capOutput({ tool_id: "demo.ping", status: "completed", result: big }, "Use narrower params.", 2_000);
    expect(size(out)).toBeLessThanOrEqual(2_000);
    expect(out).toMatchObject({ tool_id: "demo.ping", status: "completed", truncated: true, note: "Use narrower params.", original_chars: size({ tool_id: "demo.ping", status: "completed", result: big }) });
    expect(typeof out.result).toBe("string");
    expect(JSON.stringify(big).startsWith(String(out.result))).toBe(true);
  });

  it("keeps the leading items of a long list and counts the rest", () => {
    const results = Array.from({ length: 100 }, (_, i) => ({ path: `notes/${i}.md`, snippet: "y".repeat(80) }));
    const out = capOutput({ results }, "Set a smaller limit.", 3_000);
    expect(size(out)).toBeLessThanOrEqual(3_000);
    const kept = out.results;
    expect(Array.isArray(kept)).toBe(true);
    if (!Array.isArray(kept)) return;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(results.slice(0, kept.length));
    expect(out.omitted_items).toBe(100 - kept.length);
    expect(out).toMatchObject({ truncated: true, note: "Set a smaller limit." });
  });

  it("previews a list whose first item alone is too long", () => {
    const out = capOutput({ results: ["z".repeat(5_000)] }, undefined, 1_000);
    expect(size(out)).toBeLessThanOrEqual(1_000);
    expect(typeof out.results).toBe("string");
    expect(out.note).toBe(GENERIC_CAP_NOTE);
    expect(out.omitted_items).toBeUndefined();
  });

  it("counts JSON escapes against the cap", () => {
    const out = capOutput({ content: "\n\"".repeat(2_000) }, "note", 500);
    expect(size(out)).toBeLessThanOrEqual(500);
    expect(String(out.content).length).toBeGreaterThan(0);
  });

  it("shrinks a second field when the first is not enough", () => {
    const out = capOutput({ a: "a".repeat(3_000), b: "b".repeat(2_000) }, "note", 1_000);
    expect(size(out)).toBeLessThanOrEqual(1_000);
    expect(out.truncated).toBe(true);
  });
});
