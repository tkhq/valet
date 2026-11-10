import { describe, expect, it } from "vitest";
import { filterSourceCitations, markForeignCitations, sourceCitationIds, normalizeSource, readSources } from "./sources.js";

describe("sources", () => {
  it("keeps known prose citations and removes unknown ids", () => {
    expect(filterSourceCitations("One [s1]. Two [s22][s2].", new Set(["s1", "s2"])))
      .toBe("One [s1]. Two [s2].");
    expect(sourceCitationIds("One [s1]. Again [s1] and [s22].")).toEqual(["s1", "s1", "s22"]);
  });

  it("marks another thread's tags so they are no longer citations, and keeps code literal", () => {
    const marked = markForeignCitations("Launch is Tuesday [s3][s1]. `[s2]` stays.", "child");
    expect(marked).toBe("Launch is Tuesday [child s3][child s1]. `[s2]` stays.");
    expect(sourceCitationIds(marked)).toEqual([]);
  });

  it("preserves literal tags in code, escaped text, and Markdown links", () => {
    const literal = "`[s9]` and ``a `[s8]` b``.\\[s7] [s6](https://example.com) [[s5]](https://example.com)\n\n```ts\nconst a = '[s4]';\n```\n~~~\n[s3]\n~~~\n    [s2]\n\t[s1]\n";
    expect(filterSourceCitations(literal, new Set())).toBe(literal);
    expect(sourceCitationIds(literal)).toEqual([]);
    expect(filterSourceCitations("```\n[s9]", new Set())).toBe("```\n[s9]");
  });

  it("does not let a shorter code fence end a longer one", () => {
    const literal = "````md\n```\n[s9]\n```\n````\nClaim [s9]";
    expect(filterSourceCitations(literal, new Set())).toBe(literal.slice(0, -4));
  });

  it("preserves code fences in blockquotes and lists, and multiline links", () => {
    for (const literal of ["> ~~~\n> [s99]\n> ~~~", "- ~~~\n  [s99]\n  ~~~", ">     [s99]", "[Read\n[s99]](https://example.com)"])
      expect(filterSourceCitations(literal, new Set())).toBe(literal);
  });

  it("preserves shortcut reference links and still validates tags before colons in prose", () => {
    const link = "[s99]: https://example.com\n\nUse [s99] for details.";
    expect(filterSourceCitations(link, new Set())).toBe(link);
    expect(sourceCitationIds(link)).toEqual([]);
    expect(filterSourceCitations("A citation [s99]: summary.", new Set())).toBe("A citation : summary.");
  });

  it("scans bracket-heavy text without removing a later supported tag", () => {
    const input = "[".repeat(40_000) + " [s1] and [s2]";
    expect(sourceCitationIds(input)).toEqual(["s1", "s2"]);
    expect(filterSourceCitations(input, new Set(["s1"]))).toBe(input.slice(0, -4));
  });

  it("keeps http(s) links and app paths, and trims text", () => {
    expect(normalizeSource({ service: "memory", title: " notes/a.md ", url: "/memory/notes/a.md", snippet: "a\n\nb" }))
      .toEqual({ service: "memory", title: "notes/a.md", url: "/memory/notes/a.md", snippet: "a b" });
    expect(normalizeSource({ service: "web", title: "Page", url: "//evil.example/x" })).toEqual({ service: "web", title: "Page" });
    expect(normalizeSource({ service: "web", title: "Page", url: "data:text/html,x" })).toEqual({ service: "web", title: "Page" });
    expect(normalizeSource({ title: "No service" })).toBeNull();
    expect(normalizeSource("s1")).toBeNull();
  });

  it("reads only well-formed records with an id from persisted details", () => {
    const result = { content: [], details: { ok: true, sources: [
      { id: "s1", service: "slack", title: "Message in #eng", url: "https://acme.slack.com/archives/C1/p1" },
      { id: "x", service: "slack", title: "Bad id" },
      { service: "slack", title: "No id" },
    ] } };
    expect(readSources(result)).toEqual([{ id: "s1", service: "slack", title: "Message in #eng", url: "https://acme.slack.com/archives/C1/p1" }]);
    expect(readSources({ text: "no details" })).toEqual([]);
    expect(readSources(null)).toEqual([]);
  });
});
