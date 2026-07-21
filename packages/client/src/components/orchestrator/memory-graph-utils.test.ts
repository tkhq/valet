import { describe, expect, it } from 'vitest';
import type { MemoryGraphEdge, MemoryGraphNode } from '@/api/types';
import {
  isDirectoryNode,
  isPlainTagNode,
  nodeTopDir,
  nodeLabel,
  nodeShortLabel,
  initialLayout,
  stepSimulation,
  runSimulation,
  ancestorDirPaths,
  nodeDegree,
  neighborSet,
  linkCounts,
  containmentFileCount,
  selectLabeledNodes,
  filterJournal,
  filterSessionHubs,
  pruneIsolatedDerivedNodes,
  nodeRadius,
  nodeShapeKind,
  fitViewBox,
  zoomViewBox,
  labelText,
  placeLabels,
  resolveOverlaps,
  type LabelCandidate,
} from './memory-graph-utils';

describe('isDirectoryNode / isPlainTagNode', () => {
  it('treats `dir:`-prefixed tag-kind nodes as directories, not tags', () => {
    const dirNode: MemoryGraphNode = { id: 'dir:projects/valet', kind: 'tag', label: 'projects/valet' };
    expect(isDirectoryNode(dirNode)).toBe(true);
    expect(isPlainTagNode(dirNode)).toBe(false);
  });

  it('treats `tag:`-prefixed tag-kind nodes as literal tags', () => {
    const tagNode: MemoryGraphNode = { id: 'tag:important', kind: 'tag', label: 'important' };
    expect(isDirectoryNode(tagNode)).toBe(false);
    expect(isPlainTagNode(tagNode)).toBe(true);
  });

  it('is false for non-tag kinds', () => {
    const concept: MemoryGraphNode = { id: 'projects/a.md', kind: 'concept', path: 'projects/a.md' };
    expect(isDirectoryNode(concept)).toBe(false);
    expect(isPlainTagNode(concept)).toBe(false);
  });
});

describe('nodeTopDir', () => {
  it('uses topDir for concept nodes', () => {
    const node: MemoryGraphNode = { id: 'projects/a.md', kind: 'concept', topDir: 'projects' };
    expect(nodeTopDir(node)).toBe('projects');
  });

  it('returns undefined for a concept node with no topDir (root file)', () => {
    const node: MemoryGraphNode = { id: 'a.md', kind: 'concept', topDir: '' };
    expect(nodeTopDir(node)).toBeUndefined();
  });

  it('derives top dir from the id for directory pseudo-nodes', () => {
    const node: MemoryGraphNode = { id: 'dir:projects/valet', kind: 'tag', label: 'projects/valet' };
    expect(nodeTopDir(node)).toBe('projects');
  });

  it('returns undefined for phantom/session/resource/tag nodes', () => {
    expect(nodeTopDir({ id: 'missing.md', kind: 'phantom' })).toBeUndefined();
    expect(nodeTopDir({ id: 'session:abc', kind: 'session', label: 'abc' })).toBeUndefined();
    expect(nodeTopDir({ id: 'resource:x', kind: 'resource', label: 'x' })).toBeUndefined();
    expect(nodeTopDir({ id: 'tag:foo', kind: 'tag', label: 'foo' })).toBeUndefined();
  });
});

describe('nodeLabel', () => {
  it('prefers title, falls back to path, for concept nodes', () => {
    expect(nodeLabel({ id: 'a.md', kind: 'concept', title: 'A', path: 'a.md' })).toBe('A');
    expect(nodeLabel({ id: 'a.md', kind: 'concept', path: 'a.md' })).toBe('a.md');
  });

  it('strips the `dir:` prefix for directory nodes', () => {
    expect(nodeLabel({ id: 'dir:projects/valet', kind: 'tag', label: 'projects/valet' })).toBe('projects/valet');
  });

  it('strips the `tag:` prefix for plain tag nodes', () => {
    expect(nodeLabel({ id: 'tag:important', kind: 'tag', label: 'important' })).toBe('important');
  });

  it('falls back to label, then id, for other kinds', () => {
    expect(nodeLabel({ id: 'session:abc', kind: 'session', label: 'abc' })).toBe('abc');
    expect(nodeLabel({ id: 'missing.md', kind: 'phantom' })).toBe('missing.md');
  });
});

describe('nodeShortLabel', () => {
  it('strips the .md extension from a concept node path basename', () => {
    expect(nodeShortLabel({ id: 'projects/valet/notes.md', kind: 'concept', path: 'projects/valet/notes.md' })).toBe(
      'notes',
    );
  });

  it('leaves non-.md basenames untouched', () => {
    expect(nodeShortLabel({ id: 'a.txt', kind: 'concept', path: 'a.txt' })).toBe('a.txt');
  });

  it('falls back to nodeLabel for non-concept kinds', () => {
    expect(nodeShortLabel({ id: 'session:abc', kind: 'session', label: 'abc' })).toBe('abc');
  });
});

describe('nodeDegree / neighborSet / linkCounts', () => {
  const edges: MemoryGraphEdge[] = [
    { from: 'a', to: 'b', kind: 'link' },
    { from: 'c', to: 'a', kind: 'link' },
    { from: 'a', to: 'd', kind: 'session' },
  ];

  it('counts every edge touching a node regardless of kind', () => {
    expect(nodeDegree('a', edges)).toBe(3);
    expect(nodeDegree('b', edges)).toBe(1);
    expect(nodeDegree('zzz', edges)).toBe(0);
  });

  it('collects the set of directly connected node ids', () => {
    expect(neighborSet('a', edges)).toEqual(new Set(['b', 'c', 'd']));
  });

  it('splits out/in counts restricted to link-kind edges', () => {
    expect(linkCounts('a', edges)).toEqual({ out: 1, in: 1 });
    expect(linkCounts('d', edges)).toEqual({ out: 0, in: 0 });
  });
});

describe('containmentFileCount', () => {
  const nodesById = new Map<string, MemoryGraphNode>([
    ['dir:projects', { id: 'dir:projects', kind: 'tag', label: 'projects' }],
    ['projects/a.md', { id: 'projects/a.md', kind: 'concept', path: 'projects/a.md' }],
    ['dir:projects/sub', { id: 'dir:projects/sub', kind: 'tag', label: 'projects/sub' }],
    ['tag:important', { id: 'tag:important', kind: 'tag', label: 'important' }],
  ]);
  const edges: MemoryGraphEdge[] = [
    { from: 'dir:projects', to: 'projects/a.md', kind: 'containment' },
    { from: 'dir:projects', to: 'dir:projects/sub', kind: 'containment' },
    { from: 'projects/a.md', to: 'tag:important', kind: 'containment' },
  ];

  it('counts only concept-node targets in the outbound direction (directory "N files")', () => {
    expect(containmentFileCount('dir:projects', edges, nodesById, 'out')).toBe(1);
  });

  it('counts concept-node sources in the inbound direction (tag "N tagged files")', () => {
    expect(containmentFileCount('tag:important', edges, nodesById, 'in')).toBe(1);
  });
});

describe('selectLabeledNodes', () => {
  it('labels every node when the graph is at or under maxAlways', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    expect(selectLabeledNodes(nodes, [], 40).size).toBe(40);
  });

  it('above maxAlways: only labels concept nodes with degree >= 3', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    // n0 gets 3 edges (degree 3), everyone else gets at most 1.
    const edges: MemoryGraphEdge[] = [
      { from: 'n0', to: 'n1', kind: 'link' },
      { from: 'n0', to: 'n2', kind: 'link' },
      { from: 'n0', to: 'n3', kind: 'link' },
    ];
    const labeled = selectLabeledNodes(nodes, edges, 40);
    expect(labeled.has('n0')).toBe(true);
    expect(labeled.has('n1')).toBe(false);
    expect(labeled.has('n39')).toBe(false);
  });

  it('above maxAlways: directory/session/resource nodes are always labeled', () => {
    const nodes: MemoryGraphNode[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, kind: 'concept' as const })),
      { id: 'dir:projects', kind: 'tag', label: 'projects' },
      { id: 'session:abc', kind: 'session', label: 'abc' },
      { id: 'resource:x', kind: 'resource', label: 'x' },
      { id: 'tag:foo', kind: 'tag', label: 'foo' },
    ];
    const labeled = selectLabeledNodes(nodes, [], 40);
    expect(labeled.has('dir:projects')).toBe(true);
    expect(labeled.has('session:abc')).toBe(true);
    expect(labeled.has('resource:x')).toBe(true);
    expect(labeled.has('tag:foo')).toBe(false);
  });
});

describe('filterSessionHubs', () => {
  it('drops session hub nodes and all session edges', () => {
    const nodes: MemoryGraphNode[] = [
      { id: 'session:ses_1', kind: 'session' },
      { id: 'a.md', kind: 'concept', type: 'note' },
      { id: 'b.md', kind: 'concept', type: 'note' },
    ];
    const edges: MemoryGraphEdge[] = [
      { from: 'session:ses_1', to: 'a.md', kind: 'session' },
      { from: 'session:ses_1', to: 'b.md', kind: 'session' },
      { from: 'a.md', to: 'b.md', kind: 'link' },
    ];
    const result = filterSessionHubs(nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['a.md', 'b.md']);
    expect(result.edges).toEqual([{ from: 'a.md', to: 'b.md', kind: 'link' }]);
    expect(result.hiddenCount).toBe(1);
  });

  it('leaves a graph with no session hubs untouched (same references)', () => {
    const nodes: MemoryGraphNode[] = [{ id: 'a.md', kind: 'concept', type: 'note' }];
    const edges: MemoryGraphEdge[] = [{ from: 'a.md', to: 'a.md', kind: 'link' }];
    const result = filterSessionHubs(nodes, edges);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('pruneIsolatedDerivedNodes', () => {
  it('drops derived nodes with no edges but keeps orphan concept files', () => {
    const nodes: MemoryGraphNode[] = [
      { id: 'phantom.md', kind: 'phantom' },
      { id: 'resource:x', kind: 'resource' },
      { id: 'orphan.md', kind: 'concept', type: 'note' },
      { id: 'a.md', kind: 'concept', type: 'note' },
      { id: 'linked-phantom.md', kind: 'phantom' },
    ];
    const edges: MemoryGraphEdge[] = [{ from: 'a.md', to: 'linked-phantom.md', kind: 'link' }];
    const result = pruneIsolatedDerivedNodes(nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['orphan.md', 'a.md', 'linked-phantom.md']);
    expect(result.hiddenCount).toBe(2);
  });

  it('leaves a fully-connected graph untouched (same references)', () => {
    const nodes: MemoryGraphNode[] = [
      { id: 'a.md', kind: 'concept', type: 'note' },
      { id: 'phantom.md', kind: 'phantom' },
    ];
    const edges: MemoryGraphEdge[] = [{ from: 'a.md', to: 'phantom.md', kind: 'link' }];
    const result = pruneIsolatedDerivedNodes(nodes, edges);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('filterJournal', () => {
  it('drops journal-entry concept nodes and any edge touching them', () => {
    const nodes: MemoryGraphNode[] = [
      { id: 'j1.md', kind: 'concept', type: 'journal-entry' },
      { id: 'j2.md', kind: 'concept', type: 'journal-entry' },
      { id: 'a.md', kind: 'concept', type: 'note' },
    ];
    const edges: MemoryGraphEdge[] = [
      { from: 'j1.md', to: 'a.md', kind: 'link' },
      { from: 'j1.md', to: 'j2.md', kind: 'link' },
      { from: 'a.md', to: 'a.md', kind: 'link' },
    ];
    const result = filterJournal(nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['a.md']);
    expect(result.edges).toEqual([{ from: 'a.md', to: 'a.md', kind: 'link' }]);
    expect(result.hiddenCount).toBe(2);
  });

  it('leaves a graph with no journal entries untouched (same references)', () => {
    const nodes: MemoryGraphNode[] = [{ id: 'a.md', kind: 'concept', type: 'note' }];
    const edges: MemoryGraphEdge[] = [{ from: 'a.md', to: 'a.md', kind: 'link' }];
    const result = filterJournal(nodes, edges);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('nodeRadius / nodeShapeKind', () => {
  it('scales concept radius with degree, clamped to [5, 12]', () => {
    expect(nodeRadius('concept', 0)).toBe(5);
    expect(nodeRadius('concept', 2)).toBe(6);
    expect(nodeRadius('concept', 20)).toBe(12);
  });

  it('keeps fixed base radii for non-concept shapes regardless of degree', () => {
    expect(nodeRadius('phantom', 10)).toBe(5);
    expect(nodeRadius('session', 10)).toBe(6);
    expect(nodeRadius('resource', 10)).toBe(6);
    expect(nodeRadius('directory', 10)).toBe(8);
    expect(nodeRadius('tag', 10)).toBe(4.5);
  });

  it('resolves the shared tag kind into directory vs tag shapes', () => {
    expect(nodeShapeKind({ id: 'dir:a', kind: 'tag', label: 'a' })).toBe('directory');
    expect(nodeShapeKind({ id: 'tag:a', kind: 'tag', label: 'a' })).toBe('tag');
    expect(nodeShapeKind({ id: 'a.md', kind: 'concept' })).toBe('concept');
  });
});

describe('fitViewBox', () => {
  it('returns a default box for an empty point set', () => {
    expect(fitViewBox([])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('tightly wraps a cluster of points with padding, no dead space', () => {
    const vb = fitViewBox(
      [
        { x: 100, y: 100 },
        { x: 200, y: 150 },
      ],
      0.1,
    );
    // Content spans 100 wide / 50 tall; plus fixed node margin and 10% pad.
    expect(vb.width).toBeGreaterThan(100);
    expect(vb.height).toBeGreaterThan(50);
    expect(vb.x).toBeLessThan(100);
    expect(vb.y).toBeLessThan(100);
    // The box should comfortably contain both points.
    expect(vb.x + vb.width).toBeGreaterThan(200);
    expect(vb.y + vb.height).toBeGreaterThan(150);
  });

  it('is much tighter around a small cluster than a fixed large canvas', () => {
    const vb = fitViewBox([
      { x: 300, y: 200 },
      { x: 320, y: 210 },
      { x: 310, y: 230 },
    ]);
    expect(vb.width).toBeLessThan(200);
    expect(vb.height).toBeLessThan(200);
  });
});

describe('zoomViewBox', () => {
  const base: ReturnType<typeof fitViewBox> = { x: 0, y: 0, width: 400, height: 300 };
  const limits = { minWidth: 100, maxWidth: 1600 };

  it('zooms in (factor > 1) around the cursor point, shrinking the box', () => {
    const next = zoomViewBox(base, 2, 200, 150, limits);
    expect(next.width).toBe(200);
    expect(next.height).toBe(150);
    // Zooming around the exact center keeps it centered.
    expect(next.x).toBeCloseTo(100);
    expect(next.y).toBeCloseTo(75);
  });

  it('zooms out (factor < 1), growing the box', () => {
    const next = zoomViewBox(base, 0.5, 200, 150, limits);
    expect(next.width).toBe(800);
    expect(next.height).toBe(600);
  });

  it('clamps the resulting width/height to the given limits', () => {
    const zoomedInTooFar = zoomViewBox(base, 100, 200, 150, limits);
    expect(zoomedInTooFar.width).toBe(limits.minWidth);
    const zoomedOutTooFar = zoomViewBox(base, 0.01, 200, 150, limits);
    expect(zoomedOutTooFar.width).toBe(limits.maxWidth);
  });

  it('keeps the point under the cursor fixed in user-space', () => {
    const cx = 100;
    const cy = 80;
    const next = zoomViewBox(base, 2, cx, cy, limits);
    // The cursor's relative position within the viewBox should be unchanged.
    const beforeRelX = (cx - base.x) / base.width;
    const afterRelX = (cx - next.x) / next.width;
    expect(afterRelX).toBeCloseTo(beforeRelX);
  });
});

describe('labelText', () => {
  it('middle-truncates a long concept filename to 22 chars', () => {
    const node: MemoryGraphNode = {
      id: 'projects/valet/very-long-descriptive-filename-here.md',
      kind: 'concept',
      path: 'projects/valet/very-long-descriptive-filename-here.md',
    };
    const text = labelText(node);
    expect(text.length).toBeLessThanOrEqual(22);
    expect(text).toContain('…');
    expect(text.startsWith('very-long')).toBe(true);
  });

  it('leaves a short concept filename untouched', () => {
    const node: MemoryGraphNode = { id: 'a.md', kind: 'concept', path: 'notes.md' };
    expect(labelText(node)).toBe('notes');
  });

  it('reduces a resource URL to hostname + first path segment', () => {
    const node: MemoryGraphNode = {
      id: 'resource:https://github.com/tkhq/some-very-long-repo-name/issues/123',
      kind: 'resource',
      label: 'https://github.com/tkhq/some-very-long-repo-name/issues/123',
    };
    expect(labelText(node)).toMatch(/^github\.com\/tkhq/);
    expect(labelText(node).length).toBeLessThanOrEqual(22);
  });

  it('reduces a resource with no path to just the hostname', () => {
    const node: MemoryGraphNode = { id: 'resource:https://example.com', kind: 'resource', label: 'https://example.com' };
    expect(labelText(node)).toBe('example.com');
  });

  it('always labels session nodes as "session"', () => {
    const node: MemoryGraphNode = { id: 'session:abc', kind: 'session', label: 'a-very-specific-session-id-abc123' };
    expect(labelText(node)).toBe('session');
  });

  it('keeps directory/tag names to 18 chars', () => {
    const dirNode: MemoryGraphNode = {
      id: 'dir:projects/some-really-long-nested-directory-path',
      kind: 'tag',
      label: 'projects/some-really-long-nested-directory-path',
    };
    expect(labelText(dirNode).length).toBeLessThanOrEqual(18);
    const tagNode: MemoryGraphNode = { id: 'tag:short', kind: 'tag', label: 'short' };
    expect(labelText(tagNode)).toBe('short');
  });
});

describe('placeLabels', () => {
  const fontSizeUser = 11;

  it('places only the higher-priority label when two candidates overlap', () => {
    const candidates: LabelCandidate[] = [
      { id: 'low', x: 100, y: 100, r: 5, text: 'low-priority', priority: 1 },
      { id: 'high', x: 102, y: 100, r: 5, text: 'high-priority', priority: 10 },
    ];
    const placed = placeLabels(candidates, fontSizeUser);
    expect(placed.has('high')).toBe(true);
    expect(placed.has('low')).toBe(false);
    expect(placed.size).toBe(1);
  });

  it('places both labels when they are far apart (disjoint rects)', () => {
    const candidates: LabelCandidate[] = [
      { id: 'a', x: 0, y: 0, r: 5, text: 'alpha', priority: 1 },
      { id: 'b', x: 1000, y: 1000, r: 5, text: 'beta', priority: 1 },
    ];
    const placed = placeLabels(candidates, fontSizeUser);
    expect(placed.size).toBe(2);
  });

  it('places more labels as the on-screen font size shrinks (zooming in)', () => {
    // A cluster of same-priority nodes close together — at a large font size
    // most will conflict; at a small font size (deeper zoom) more fit.
    const candidates: LabelCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      x: i * 12,
      y: 0,
      r: 5,
      text: `node${i}`,
      priority: 1,
    }));
    const placedLarge = placeLabels(candidates, 20);
    const placedSmall = placeLabels(candidates, 4);
    expect(placedSmall.size).toBeGreaterThan(placedLarge.size);
  });
});

describe('resolveOverlaps', () => {
  it('pushes an overlapping pair apart until they clear minGap', () => {
    const positions = [
      { id: 'a', x: 100, y: 100, r: 5 },
      { id: 'b', x: 102, y: 100, r: 5 },
    ];
    const resolved = resolveOverlaps(positions, 2);
    const a = resolved.get('a')!;
    const b = resolved.get('b')!;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    expect(dist).toBeGreaterThanOrEqual(5 + 5 + 2 - 0.01);
  });

  it('leaves already-separated nodes untouched', () => {
    const positions = [
      { id: 'a', x: 0, y: 0, r: 5 },
      { id: 'b', x: 100, y: 0, r: 5 },
    ];
    const resolved = resolveOverlaps(positions, 2);
    expect(resolved.get('a')).toEqual({ x: 0, y: 0 });
    expect(resolved.get('b')).toEqual({ x: 100, y: 0 });
  });
});

describe('ancestorDirPaths', () => {
  it('returns each ancestor directory, shallowest first', () => {
    expect(ancestorDirPaths('projects/valet/notes.md')).toEqual(['projects', 'projects/valet']);
  });

  it('returns an empty array for a root-level file', () => {
    expect(ancestorDirPaths('notes.md')).toEqual([]);
  });
});

describe('initialLayout', () => {
  it('returns one placed node per input node, all within bounds', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      kind: 'concept',
    }));
    const placed = initialLayout(nodes, 400, 300);
    expect(placed).toHaveLength(12);
    for (const p of placed) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.vx).toBe(0);
      expect(p.vy).toBe(0);
    }
  });

  it('is deterministic across repeated calls', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    expect(initialLayout(nodes, 400, 300)).toEqual(initialLayout(nodes, 400, 300));
  });

  it('places a single node dead center', () => {
    const placed = initialLayout([{ id: 'only', kind: 'concept' }], 400, 300);
    expect(placed).toEqual([{ id: 'only', x: 200, y: 150, vx: 0, vy: 0 }]);
  });

  it('handles an empty node list', () => {
    expect(initialLayout([], 400, 300)).toEqual([]);
  });
});

describe('stepSimulation', () => {
  it('pushes two coincident nodes apart', () => {
    const nodes = [
      { id: 'a', x: 100, y: 100, vx: 0, vy: 0 },
      { id: 'b', x: 100, y: 100, vx: 0, vy: 0 },
    ];
    const next = stepSimulation(nodes, [], 1, { width: 400, height: 300 });
    const dist = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
    expect(dist).toBeGreaterThan(0);
  });

  it('pulls linked nodes that are too far apart closer together', () => {
    const nodes = [
      { id: 'a', x: 50, y: 150, vx: 0, vy: 0 },
      { id: 'b', x: 350, y: 150, vx: 0, vy: 0 },
    ];
    const edges: MemoryGraphEdge[] = [{ from: 'a', to: 'b', kind: 'link' }];
    const before = Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y);
    const next = stepSimulation(nodes, edges, 1, { width: 400, height: 300 });
    const after = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
    expect(after).toBeLessThan(before);
  });

  it('keeps nodes within the canvas bounds', () => {
    const nodes = [{ id: 'a', x: 0, y: 0, vx: -50, vy: -50 }];
    const next = stepSimulation(nodes, [], 1, { width: 200, height: 200 });
    expect(next[0].x).toBeGreaterThanOrEqual(0);
    expect(next[0].y).toBeGreaterThanOrEqual(0);
    expect(next[0].x).toBeLessThanOrEqual(200);
    expect(next[0].y).toBeLessThanOrEqual(200);
  });

  it('ignores edges referencing unknown node ids instead of throwing', () => {
    const nodes = [{ id: 'a', x: 100, y: 100, vx: 0, vy: 0 }];
    const edges: MemoryGraphEdge[] = [{ from: 'a', to: 'ghost', kind: 'link' }];
    expect(() => stepSimulation(nodes, edges, 1, { width: 400, height: 300 })).not.toThrow();
  });
});

describe('runSimulation', () => {
  it('returns a position for every node', () => {
    const nodes: MemoryGraphNode[] = [
      { id: 'a', kind: 'concept', topDir: 'projects' },
      { id: 'b', kind: 'concept', topDir: 'projects' },
      { id: 'c', kind: 'phantom' },
    ];
    const edges: MemoryGraphEdge[] = [
      { from: 'a', to: 'b', kind: 'link' },
      { from: 'a', to: 'c', kind: 'link' },
    ];
    const positions = runSimulation(nodes, edges, 400, 300);
    expect(positions.size).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      const pos = positions.get(id);
      expect(pos).toBeDefined();
      expect(Number.isFinite(pos!.x)).toBe(true);
      expect(Number.isFinite(pos!.y)).toBe(true);
      expect(pos!.x).toBeGreaterThanOrEqual(0);
      expect(pos!.x).toBeLessThanOrEqual(400);
      expect(pos!.y).toBeGreaterThanOrEqual(0);
      expect(pos!.y).toBeLessThanOrEqual(300);
    }
  });

  it('is deterministic given the same input', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    const edges: MemoryGraphEdge[] = Array.from({ length: 15 }, (_, i) => ({
      from: `n${i}`,
      to: `n${(i + 1) % 20}`,
      kind: 'link' as const,
    }));
    const a = runSimulation(nodes, edges, 500, 400);
    const b = runSimulation(nodes, edges, 500, 400);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('settles (later ticks move less than earlier ticks)', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    const edges: MemoryGraphEdge[] = Array.from({ length: 10 }, (_, i) => ({
      from: `n${i}`,
      to: `n${(i + 1) % 15}`,
      kind: 'link' as const,
    }));

    const opts = { width: 400, height: 300 };
    const decay = 1 - Math.pow(0.001, 1 / 220);

    const movementAt = (iterations: number) => {
      let s = initialLayout(nodes, 400, 300);
      let a = 1;
      let last = 0;
      for (let i = 0; i < iterations; i++) {
        const next = stepSimulation(s, edges, a, opts);
        last = next.reduce((sum, n, idx) => sum + Math.abs(n.x - s[idx].x) + Math.abs(n.y - s[idx].y), 0);
        s = next;
        a *= 1 - decay;
      }
      return last;
    };

    const earlyMovement = movementAt(5);
    const lateMovement = movementAt(150);
    expect(lateMovement).toBeLessThan(earlyMovement);
  });

  it('handles an empty graph without error', () => {
    const positions = runSimulation([], [], 400, 300);
    expect(positions.size).toBe(0);
  });

  it('spreads linked pairs out instead of packing into a tight blob', () => {
    // A small connected graph; with the pre-fix charge/link constants this
    // packed into ~linkDistance apart regardless of canvas size. Assert the
    // settled distance between linked nodes is a healthy multiple of their
    // (small, fixed) radii so `fitViewBox` doesn't have to zoom in deep.
    const nodes: MemoryGraphNode[] = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    const edges: MemoryGraphEdge[] = Array.from({ length: 9 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      kind: 'link' as const,
    }));
    const positions = runSimulation(nodes, edges, 1200, 900);
    const radius = nodeRadius('concept', 2); // roughly this graph's degree

    let totalDist = 0;
    for (const edge of edges) {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      totalDist += Math.hypot(from.x - to.x, from.y - to.y);
    }
    const avgDist = totalDist / edges.length;
    expect(avgDist).toBeGreaterThanOrEqual(radius * 6);
  });

  it('stays responsive for a large (500-node) graph — bounded iteration count', () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    const edges: MemoryGraphEdge[] = Array.from({ length: 500 }, (_, i) => ({
      from: `n${i}`,
      to: `n${(i + 7) % 500}`,
      kind: 'link' as const,
    }));
    const start = Date.now();
    const positions = runSimulation(nodes, edges, 900, 700, 60);
    const elapsed = Date.now() - start;
    expect(positions.size).toBe(500);
    expect(elapsed).toBeLessThan(5000);
  });
});
