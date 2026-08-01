import { describe, expect, it } from "vitest";
import type { MemoryGraphResponse } from "~/api/memory-types";
import { filterGraph, layoutGraph, spotlightSet } from "./memory-graph";

const graph: MemoryGraphResponse = {
  nodes: [
    { id: "journal/2026-08-01.md", kind: "concept", topDir: "journal" },
    { id: "people/alice.md", kind: "concept", topDir: "people" },
    { id: "people/bob.md", kind: "concept", topDir: "people" },
    { id: "dir:journal", kind: "dir", title: "journal", topDir: "journal" },
    { id: "dir:people", kind: "dir", title: "people", topDir: "people" },
    { id: "gone.md", kind: "phantom", path: "gone.md" },
  ],
  edges: [
    { from: "dir:journal", to: "journal/2026-08-01.md", kind: "containment" },
    { from: "dir:people", to: "people/alice.md", kind: "containment" },
    { from: "dir:people", to: "people/bob.md", kind: "containment" },
    { from: "people/alice.md", to: "people/bob.md", kind: "link" },
    { from: "journal/2026-08-01.md", to: "gone.md", kind: "link" },
  ],
};

describe("filterGraph", () => {
  it("journal off removes journal concepts, then prunes emptied hubs and phantoms", () => {
    const g = filterGraph(graph, { journal: false, folders: true });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).not.toContain("journal/2026-08-01.md");
    expect(ids).not.toContain("dir:journal"); // hub emptied → pruned
    expect(ids).not.toContain("gone.md"); // only referenced from journal → pruned
    expect(ids).toContain("people/alice.md");
    expect(g.edges).toHaveLength(3);
  });

  it("folders off removes dir hubs and containment edges but keeps links", () => {
    const g = filterGraph(graph, { journal: true, folders: false });
    expect(g.nodes.some((n) => n.kind === "dir")).toBe(false);
    expect(g.edges.every((e) => e.kind === "link")).toBe(true);
    expect(g.edges).toHaveLength(2);
  });

  it("everything on passes through intact", () => {
    const g = filterGraph(graph, { journal: true, folders: true });
    expect(g.nodes).toHaveLength(6);
    expect(g.edges).toHaveLength(5);
  });
});

describe("spotlightSet", () => {
  it("contains the node and its direct neighbors in both directions", () => {
    const set = spotlightSet("people/alice.md", graph.edges);
    expect(set).toEqual(new Set(["people/alice.md", "people/bob.md", "dir:people"]));
  });
});

describe("layoutGraph", () => {
  it("assigns a finite position to every node, no two identical", () => {
    const g = filterGraph(graph, { journal: true, folders: true });
    const positions = layoutGraph(g.nodes, g.edges);
    expect(positions.size).toBe(g.nodes.length);
    const seen = new Set<string>();
    for (const { x, y } of positions.values()) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      seen.add(`${Math.round(x)},${Math.round(y)}`);
    }
    expect(seen.size).toBe(g.nodes.length);
  });
});
