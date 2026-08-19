import { describe, expect, it } from "vitest";
import {
  absolutizeLinkTargets,
  buildMemoryGraph,
  extractLinkTargets,
  MAX_GRAPH_NODES,
  MAX_PHANTOM_NODES,
  MAX_SCAN_CHARS,
  resolveLinkTarget,
  rewriteLinkTargets,
  type GraphSourceFile,
} from "./memory-graph.js";

function file(path: string, content = "", title = path, type = "note"): GraphSourceFile {
  return { path, title, type, content };
}

describe("resolveLinkTarget", () => {
  it("resolves root-relative targets from the bundle root", () => {
    expect(resolveLinkTarget("journal/2026-08-01.md", "/people/alice.md")).toBe("people/alice.md");
  });

  it("resolves relative targets against the source directory", () => {
    expect(resolveLinkTarget("projects/valet/a.md", "b.md")).toBe("projects/valet/b.md");
    expect(resolveLinkTarget("projects/valet/a.md", "../infra/c.md")).toBe("projects/infra/c.md");
    expect(resolveLinkTarget("projects/valet/a.md", "./d.md")).toBe("projects/valet/d.md");
  });

  it("skips external URLs, schemes, anchors, and template garbage", () => {
    expect(resolveLinkTarget("a.md", "https://example.com/x")).toBeNull();
    expect(resolveLinkTarget("a.md", "mailto:me@example.com")).toBeNull();
    expect(resolveLinkTarget("a.md", "#section")).toBeNull();
    expect(resolveLinkTarget("a.md", "{url}")).toBeNull();
  });

  it("strips fragments from cross-file targets", () => {
    expect(resolveLinkTarget("a.md", "/notes/b.md#part")).toBe("notes/b.md");
  });
});

describe("extractLinkTargets", () => {
  it("finds markdown links, deduped, self-links excluded", () => {
    const body = "see [b](/b.md) and [b again](/b.md) and [self](/a.md)";
    expect(extractLinkTargets("a.md", body)).toEqual(["b.md"]);
  });

  it("stops scanning past the per-file budget (DoS guard)", () => {
    const body = `${"x".repeat(MAX_SCAN_CHARS)}\n[late](/notes/late.md)`;
    expect(extractLinkTargets("a.md", body)).toEqual([]);
    const early = `[early](/notes/early.md)\n${"x".repeat(MAX_SCAN_CHARS)}`;
    expect(extractLinkTargets("a.md", early)).toEqual(["notes/early.md"]);
  });

  it("ignores links inside code fences and inline code", () => {
    const body = ["```", "[x](/fenced.md)", "```", "`[y](/inline.md)` and [z](/real.md)"].join("\n");
    expect(extractLinkTargets("a.md", body)).toEqual(["real.md"]);
  });
});

describe("rewriteLinkTargets", () => {
  it("rewrites relative and rooted targets that resolve to the old path", () => {
    const body = "see [alice](../people/alice.md) and [rooted](/people/alice.md) and [other](/people/bob.md)";
    const { content, rewrote } = rewriteLinkTargets("journal/day.md", body, "people/alice.md", "people/alice-smith.md");
    expect(rewrote).toBe(true);
    expect(content).toBe(
      "see [alice](/people/alice-smith.md) and [rooted](/people/alice-smith.md) and [other](/people/bob.md)",
    );
  });

  it("preserves anchors and tolerates a missing .md extension", () => {
    const body = "[a](/notes/a#section) stays anchored";
    const { content, rewrote } = rewriteLinkTargets("x.md", body, "notes/a.md", "archive/a.md");
    expect(rewrote).toBe(true);
    expect(content).toBe("[a](/archive/a.md#section) stays anchored");
  });

  it("leaves code fences and inline code alone, and reports rewrote: false when nothing matches", () => {
    const body = ["```", "[x](/old.md)", "```", "`[y](/old.md)` and [z](/unrelated.md)"].join("\n");
    const result = rewriteLinkTargets("a.md", body, "old.md", "new.md");
    expect(result.rewrote).toBe(false);
    expect(result.content).toBe(body);
  });

  it("preserves a percent-encoded anchor (%23) instead of dropping it", () => {
    const body = "see [x](notes/a.md%23setup) here";
    const { content, rewrote } = rewriteLinkTargets("index.md", body, "notes/a.md", "archive/a.md");
    expect(rewrote).toBe(true);
    expect(content).toBe("see [x](/archive/a.md#setup) here");
  });

  it("percent-encodes a destination path that would break link parsing", () => {
    const body = "[x](/notes/a.md)";
    const { content } = rewriteLinkTargets("index.md", body, "notes/a.md", "notes/c d.md");
    expect(content).toBe("[x](/notes/c%20d.md)");
    // The rewritten link must stay visible to extraction.
    expect(extractLinkTargets("index.md", content)).toEqual(["notes/c d.md"]);
  });

  it("shares the scan budget with extractLinkTargets — a link past the cap on an early-starting line is not rewritten", () => {
    const body = `${"x".repeat(MAX_SCAN_CHARS)}[late](/old.md)`;
    expect(extractLinkTargets("a.md", body)).toEqual([]);
    const result = rewriteLinkTargets("a.md", body, "old.md", "new.md");
    expect(result.rewrote).toBe(false);
    expect(result.content).toBe(body);
  });
});

describe("absolutizeLinkTargets", () => {
  it("roots relative targets to their resolution from the source path, keeping anchors", () => {
    const body = "see [b](bar.md) and [up](../people/alice.md#bio) and [rooted](/notes/x.md)";
    const { content, changed } = absolutizeLinkTargets("projects/valet/a.md", body);
    expect(changed).toBe(true);
    expect(content).toBe("see [b](/projects/valet/bar.md) and [up](/projects/people/alice.md#bio) and [rooted](/notes/x.md)");
  });

  it("skips external URLs, anchors, and template garbage; reports changed: false when nothing is relative", () => {
    const body = "[w](https://example.com) [a](#sec) [t]({url}) [r](/rooted.md)";
    const result = absolutizeLinkTargets("notes/a.md", body);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(body);
  });
});

describe("buildMemoryGraph", () => {
  it("emits concept nodes with topDir, dir hubs, and containment edges", () => {
    const g = buildMemoryGraph([file("people/alice.md"), file("people/bob.md"), file("root.md")]);
    const dirNode = g.nodes.find((n) => n.kind === "dir");
    expect(dirNode).toMatchObject({ id: "dir:people", title: "people" });
    expect(g.nodes.find((n) => n.id === "people/alice.md")).toMatchObject({
      kind: "concept",
      topDir: "people",
    });
    expect(g.nodes.find((n) => n.id === "root.md")).toMatchObject({ topDir: "" });
    expect(g.edges.filter((e) => e.kind === "containment")).toHaveLength(2);
  });

  it("emits link edges between stored files, tolerating a missing .md extension", () => {
    const g = buildMemoryGraph([
      file("a.md", "[b](/notes/b.md) and [c](/notes/c)"),
      file("notes/b.md"),
      file("notes/c.md"),
    ]);
    const links = g.edges.filter((e) => e.kind === "link");
    expect(links).toEqual([
      { from: "a.md", to: "notes/b.md", kind: "link" },
      { from: "a.md", to: "notes/c.md", kind: "link" },
    ]);
  });

  it("turns path-shaped dangling targets into capped phantom nodes", () => {
    const g = buildMemoryGraph([file("a.md", "[gone](/notes/gone.md) and [junk](url)")]);
    const phantom = g.nodes.find((n) => n.kind === "phantom");
    expect(phantom).toMatchObject({ id: "notes/gone.md", title: "gone.md" });
    expect(g.nodes.filter((n) => n.kind === "phantom")).toHaveLength(1);
    expect(g.edges).toContainEqual({ from: "a.md", to: "notes/gone.md", kind: "link" });
  });

  it("caps phantom nodes by reference count", () => {
    const links = Array.from(
      { length: MAX_PHANTOM_NODES + 5 },
      (_, i) => `[x](/gone/${i}.md)`,
    ).join(" ");
    // gone/0.md referenced twice — must survive the cap.
    const g = buildMemoryGraph([file("a.md", links), file("b.md", "[x](/gone/0.md)")]);
    const phantomIds = g.nodes.filter((n) => n.kind === "phantom").map((n) => n.id);
    expect(phantomIds).toHaveLength(MAX_PHANTOM_NODES);
    expect(phantomIds).toContain("gone/0.md");
  });

  it("caps concept nodes and drops edges whose endpoint fell out", () => {
    const files = Array.from({ length: MAX_GRAPH_NODES + 10 }, (_, i) =>
      file(`n/${i}.md`, i === 0 ? `[last](/n/${MAX_GRAPH_NODES + 9}.md)` : ""),
    );
    const g = buildMemoryGraph(files);
    expect(g.nodes.filter((n) => n.kind === "concept")).toHaveLength(MAX_GRAPH_NODES);
    // The target exists in storage but fell past the cap: no edge, no phantom.
    expect(g.edges.filter((e) => e.kind === "link")).toHaveLength(0);
    expect(g.nodes.filter((n) => n.kind === "phantom")).toHaveLength(0);
  });
});
