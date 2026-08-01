import { describe, expect, it } from "vitest";
import type { MemoryGraphResponse } from "~/api/memory-types";
import {
  dotSize,
  filterGraph,
  LABEL_ALL_MAX,
  LABEL_MIN_IN_LINKS,
  layoutGraph,
  linkInDegree,
  persistentLabelIds,
  spotlightSet,
} from "./memory-graph";

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

describe("linkInDegree / dotSize", () => {
  it("counts only incoming link edges, not containment", () => {
    const deg = linkInDegree(graph.edges);
    expect(deg.get("people/bob.md")).toBe(1);
    expect(deg.get("gone.md")).toBe(1);
    expect(deg.get("people/alice.md")).toBeUndefined(); // containment only
  });

  it("dot size grows with sqrt(in-links) and stays bounded", () => {
    expect(dotSize(0)).toBe(9);
    expect(dotSize(4)).toBeGreaterThan(dotSize(1));
    expect(dotSize(1000)).toBe(26);
  });
});

describe("persistentLabelIds", () => {
  it("labels everything on a small graph", () => {
    const ids = persistentLabelIds(graph.nodes, linkInDegree(graph.edges));
    expect(ids.size).toBe(graph.nodes.length);
  });

  it("on a large graph labels dir hubs and well-linked concepts only", () => {
    const nodes: MemoryGraphResponse["nodes"] = Array.from({ length: LABEL_ALL_MAX + 1 }, (_, i) => ({
      id: `n/${i}.md`,
      kind: "concept",
      topDir: "n",
    }));
    nodes.push({ id: "dir:n", kind: "dir", topDir: "n" });
    const inDeg = new Map([["n/0.md", LABEL_MIN_IN_LINKS]]);
    const ids = persistentLabelIds(nodes, inDeg);
    expect(ids.has("n/0.md")).toBe(true);
    expect(ids.has("dir:n")).toBe(true);
    expect(ids.has("n/1.md")).toBe(false);
  });
});

describe("layoutGraph", () => {
  it("clusters nodes near their directory anchor", () => {
    // Two directories, no cross-links: each family should stay coherent —
    // every node closer to its own family's centroid than to the other's.
    const nodes = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a/${i}.md`, kind: "concept" as const, topDir: "a" })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `b/${i}.md`, kind: "concept" as const, topDir: "b" })),
    ];
    const pos = layoutGraph(nodes, []);
    const centroid = (prefix: string) => {
      const pts = [...pos.entries()].filter(([id]) => id.startsWith(prefix)).map(([, p]) => p);
      return {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
    };
    const ca = centroid("a/");
    const cb = centroid("b/");
    const d = (p: { x: number; y: number }, c: { x: number; y: number }) => Math.hypot(p.x - c.x, p.y - c.y);
    for (const [id, p] of pos) {
      const own = id.startsWith("a/") ? ca : cb;
      const other = id.startsWith("a/") ? cb : ca;
      expect(d(p, own), id).toBeLessThan(d(p, other));
    }
  });

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
