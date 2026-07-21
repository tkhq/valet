import type { MemoryGraphEdge, MemoryGraphNode } from '@/api/types';

// ─── Node classification ────────────────────────────────────────────────────
//
// Directory-clustering pseudo-nodes reuse `kind: 'tag'` (the sealed union has
// no dedicated 'directory' kind — see packages/worker/src/lib/db/memory-graph.ts)
// with a `dir:` id prefix. Literal tag nodes use a `tag:` id prefix. Any
// renderer that treats all `kind: 'tag'` nodes the same will mislabel
// directories as tags — these two predicates are the single place that
// distinguishes them.

export const DIR_ID_PREFIX = 'dir:';
export const TAG_ID_PREFIX = 'tag:';

export function isDirectoryNode(node: MemoryGraphNode): boolean {
  return node.kind === 'tag' && node.id.startsWith(DIR_ID_PREFIX);
}

export function isPlainTagNode(node: MemoryGraphNode): boolean {
  return node.kind === 'tag' && !node.id.startsWith(DIR_ID_PREFIX);
}

/**
 * Directory this node should be color-themed by (keys into the existing
 * `DIR_COLORS` map from memory-explorer.tsx). Concept nodes already carry
 * `topDir`; directory pseudo-nodes derive it from the top segment of their
 * clustered path; every other node kind (phantom/session/resource/tag) has no
 * directory theme and falls back to the caller's default color.
 */
export function nodeTopDir(node: MemoryGraphNode): string | undefined {
  if (node.kind === 'concept') return node.topDir || undefined;
  if (isDirectoryNode(node)) {
    const dirPath = node.id.slice(DIR_ID_PREFIX.length);
    return dirPath.split('/')[0] || undefined;
  }
  return undefined;
}

/** Display label for a node, preferring the most specific field per kind. */
export function nodeLabel(node: MemoryGraphNode): string {
  if (node.kind === 'concept') return node.title || node.path || node.id;
  if (isDirectoryNode(node)) return node.id.slice(DIR_ID_PREFIX.length);
  if (isPlainTagNode(node)) return node.id.slice(TAG_ID_PREFIX.length);
  return node.label || node.id;
}

/**
 * Short on-canvas label: for concept nodes this is the file basename with the
 * `.md` extension stripped (so labels stay compact under nodes); every other
 * kind falls back to `nodeLabel`.
 */
export function nodeShortLabel(node: MemoryGraphNode): string {
  if (node.kind === 'concept') {
    const source = node.path || node.title || node.id;
    const base = source.split('/').pop() || source;
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  }
  return nodeLabel(node);
}

// ─── Degree / link-count helpers ────────────────────────────────────────────

/** Total number of edges (any kind) touching a node. */
export function nodeDegree(nodeId: string, edges: MemoryGraphEdge[]): number {
  let degree = 0;
  for (const edge of edges) {
    if (edge.from === nodeId) degree++;
    if (edge.to === nodeId) degree++;
  }
  return degree;
}

/** The set of node ids directly connected to `nodeId` by any edge. */
export function neighborSet(nodeId: string, edges: MemoryGraphEdge[]): Set<string> {
  const neighbors = new Set<string>();
  for (const edge of edges) {
    if (edge.from === nodeId) neighbors.add(edge.to);
    if (edge.to === nodeId) neighbors.add(edge.from);
  }
  return neighbors;
}

/** Outbound/inbound counts restricted to `link`-kind edges (concept-to-concept references). */
export function linkCounts(nodeId: string, edges: MemoryGraphEdge[]): { out: number; in: number } {
  let out = 0;
  let inCount = 0;
  for (const edge of edges) {
    if (edge.kind !== 'link') continue;
    if (edge.from === nodeId) out++;
    if (edge.to === nodeId) inCount++;
  }
  return { out, in: inCount };
}

/**
 * Number of `containment`-kind edges from `nodeId` whose target is a concept
 * (file) node — used by directory-node tooltips for "N files" and tag-node
 * tooltips (via the inbound direction) for "N tagged files".
 */
export function containmentFileCount(
  nodeId: string,
  edges: MemoryGraphEdge[],
  nodesById: Map<string, MemoryGraphNode>,
  direction: 'out' | 'in' = 'out',
): number {
  let count = 0;
  for (const edge of edges) {
    if (edge.kind !== 'containment') continue;
    const [anchor, other] = direction === 'out' ? [edge.from, edge.to] : [edge.to, edge.from];
    if (anchor !== nodeId) continue;
    if (nodesById.get(other)?.kind === 'concept') count++;
  }
  return count;
}

// ─── Label selection ─────────────────────────────────────────────────────────

/**
 * Decides which nodes get a persistent on-canvas text label. Small graphs
 * (<= `maxAlways`) label everything since there's no clutter risk; larger
 * graphs restrict labels to structural hubs (directory/session/resource
 * nodes) plus well-connected concept/phantom/tag nodes (degree >= 3) so the
 * canvas stays legible.
 */
export function selectLabeledNodes(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  maxAlways = 40,
): Set<string> {
  const labeled = new Set<string>();
  if (nodes.length <= maxAlways) {
    for (const node of nodes) labeled.add(node.id);
    return labeled;
  }
  for (const node of nodes) {
    if (node.kind === 'session' || node.kind === 'resource' || isDirectoryNode(node)) {
      labeled.add(node.id);
      continue;
    }
    if (nodeDegree(node.id, edges) >= 3) labeled.add(node.id);
  }
  return labeled;
}

// ─── Label truncation ───────────────────────────────────────────────────────

/** Middle-truncates `text` to at most `max` chars, preserving head and tail
 * (e.g. `long-name-here` → `long-…-here`) so identity stays recognizable. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - 1; // reserve one char for the ellipsis
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * On-canvas label text for a node, kind-aware and length-bounded so long
 * URLs, filenames, and paths can't sprawl across the graph:
 *  - concept: basename sans `.md`, middle-truncated to 22 chars
 *  - resource: hostname + first path segment only (URLs get long fast)
 *  - session: the fixed string 'session' (there's nothing more specific to show)
 *  - directory/tag: the (already short) label, truncated to 18 chars
 *  - phantom/other: falls back to `nodeLabel`, truncated to 22 chars
 */
export function labelText(node: MemoryGraphNode): string {
  switch (node.kind) {
    case 'concept':
      return middleTruncate(nodeShortLabel(node), 22);
    case 'resource': {
      const raw = nodeLabel(node);
      const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
      const [host, ...rest] = withoutScheme.split('/');
      const firstSegment = rest.find((s) => s.length > 0);
      const short = firstSegment ? `${host}/${firstSegment}` : host;
      return middleTruncate(short, 22);
    }
    case 'session':
      return 'session';
    case 'tag':
      return middleTruncate(nodeLabel(node), 18);
    default:
      return middleTruncate(nodeLabel(node), 22);
  }
}

// ─── Journal noise control ──────────────────────────────────────────────────

export interface FilteredGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  hiddenCount: number;
}

/**
 * Drops journal-entry concept nodes (and any edge touching one) before the
 * simulation runs — journal entries tend to form a dense star that otherwise
 * dominates the layout. Returns the original arrays (by reference) when
 * nothing is hidden, so callers can rely on referential stability to skip
 * re-running the simulation.
 */
export function filterJournal(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): FilteredGraph {
  const hiddenIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'concept' && node.type === 'journal-entry') hiddenIds.add(node.id);
  }
  if (hiddenIds.size === 0) return { nodes, edges, hiddenCount: 0 };
  return {
    nodes: nodes.filter((node) => !hiddenIds.has(node.id)),
    edges: edges.filter((edge) => !hiddenIds.has(edge.from) && !hiddenIds.has(edge.to)),
    hiddenCount: hiddenIds.size,
  };
}

/**
 * Drops derived session-hub nodes and session-sibling edges. Session
 * co-authorship is a weak signal — a single reorganization session welds
 * unrelated files together (moves/rewrites preserve source_session_id) — so
 * the graph hides it unless explicitly requested. Same referential-stability
 * contract as filterJournal.
 */
export function filterSessionHubs(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): FilteredGraph {
  const hiddenIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'session') hiddenIds.add(node.id);
  }
  if (hiddenIds.size === 0) return { nodes, edges, hiddenCount: 0 };
  return {
    nodes: nodes.filter((node) => !hiddenIds.has(node.id)),
    edges: edges.filter(
      (edge) => edge.kind !== 'session' && !hiddenIds.has(edge.from) && !hiddenIds.has(edge.to),
    ),
    hiddenCount: hiddenIds.size,
  };
}

/**
 * Drops derived/phantom nodes left with no edges after other filters ran.
 * A phantom or resource/session/tag hub is only information when you can see
 * what points at it — once its referencers are filtered out (e.g. journal
 * hidden), it floats disconnected and reads as noise. Real concept files are
 * never dropped: an orphan file is itself meaningful. Same referential-
 * stability contract as filterJournal.
 */
export function pruneIsolatedDerivedNodes(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): FilteredGraph {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const kept = nodes.filter((n) => n.kind === 'concept' || connected.has(n.id));
  if (kept.length === nodes.length) return { nodes, edges, hiddenCount: 0 };
  return { nodes: kept, edges, hiddenCount: nodes.length - kept.length };
}

// ─── Degree-scaled node radii ────────────────────────────────────────────────

export type NodeShapeKind = 'concept' | 'phantom' | 'session' | 'resource' | 'directory' | 'tag';

/**
 * Rendered radius (px) for a node's glyph. Only `concept` nodes scale with
 * degree (busier files get a slightly bigger dot); every other shape keeps
 * the fixed base radius the current renderer already uses, so this is purely
 * a size lookup, not a re-theme.
 */
export function nodeRadius(kind: NodeShapeKind, degree: number): number {
  switch (kind) {
    case 'concept':
      return clamp(4 + degree, 5, 12);
    case 'phantom':
      return 5;
    case 'session':
      return 6;
    case 'resource':
      return 6;
    case 'directory':
      return 8;
    case 'tag':
      return 4.5;
    default:
      return 5;
  }
}

/** Which `NodeShapeKind` a raw graph node renders as (resolves the shared `tag` kind into `directory` vs `tag`). */
export function nodeShapeKind(node: MemoryGraphNode): NodeShapeKind {
  if (node.kind === 'tag') return isDirectoryNode(node) ? 'directory' : 'tag';
  return node.kind;
}

// ─── Label de-confliction ───────────────────────────────────────────────────
//
// `selectLabeledNodes` decides which nodes are *eligible* for a label; this
// pass decides which of those eligible labels actually fit without
// overlapping, given the current on-screen font size. Font size is in *user*
// units and shrinks as the viewBox zooms out, so more labels naturally get
// room to appear as the user zooms in.

export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  r: number;
  text: string;
  /** Higher places first; ties broken by input order. */
  priority: number;
}

interface LabelRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Estimated on-canvas rect for a candidate's label, positioned below its node. */
function estimateLabelRect(c: LabelCandidate, fontSizeUser: number): LabelRect {
  const width = c.text.length * fontSizeUser * 0.6;
  const height = fontSizeUser * 1.2;
  const gap = fontSizeUser * 0.4;
  const top = c.y + c.r + gap;
  return { x1: c.x - width / 2, y1: top, x2: c.x + width / 2, y2: top + height };
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * Greedy label placement: sort candidates by priority (descending), then
 * place each one's estimated rect unless it overlaps an already-placed
 * label's rect. Rect-vs-rect only — doesn't check against unrelated node
 * circles, which keeps this simple and is enough to kill the overlapping
 * "label soup" that pure candidate-selection (`selectLabeledNodes`) can't
 * prevent on its own.
 */
export function placeLabels(candidates: LabelCandidate[], fontSizeUser: number): Set<string> {
  const sorted = [...candidates]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.priority - a.c.priority || a.i - b.i)
    .map(({ c }) => c);
  const placedRects: LabelRect[] = [];
  const placed = new Set<string>();
  for (const c of sorted) {
    const rect = estimateLabelRect(c, fontSizeUser);
    if (placedRects.some((p) => rectsOverlap(p, rect))) continue;
    placedRects.push(rect);
    placed.add(c.id);
  }
  return placed;
}

// ─── Force-directed layout (pure, dependency-free) ──────────────────────────
//
// A hand-rolled iterative force simulation: pairwise repulsion, edge springs,
// and weak centering gravity. Kept as pure functions (no DOM/React) so the
// layout math is unit-testable without rendering SVG.

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Golden-angle spiral: irrational-angle increments spread points evenly
// around a disc with no two nodes ever landing on the same ray from center.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Deterministic initial placement (no randomness, so repeated runs over the
 * same node list are reproducible): a golden-angle spiral fanned out from the
 * canvas center.
 */
export function initialLayout(nodes: MemoryGraphNode[], width: number, height: number): SimNode[] {
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.max(1, Math.min(width, height) / 2 - 20);
  const n = nodes.length;
  return nodes.map((node, i) => {
    const r = n <= 1 ? 0 : maxR * Math.sqrt((i + 0.5) / n);
    const angle = i * GOLDEN_ANGLE;
    return { id: node.id, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), vx: 0, vy: 0 };
  });
}

export interface ForceOptions {
  width: number;
  height: number;
  chargeStrength?: number;
  linkDistance?: number;
  linkStrength?: number;
  centerStrength?: number;
  damping?: number;
}

// Repulsion/link-length tuned so linked pairs settle at roughly 6+ node radii
// apart — the previous, much weaker charge packed everything into a tight
// blob, which then forced `fitViewBox` to zoom in deep and (pre label-scale
// fix) blew up every label with it. See memory-graph-utils.test.ts for the
// spread-check this is tuned against.
const DEFAULT_CHARGE = 2200;
const DEFAULT_LINK_DISTANCE = 90;
const DEFAULT_LINK_STRENGTH = 0.25;
const DEFAULT_CENTER_STRENGTH = 0.015;
const DEFAULT_DAMPING = 0.85;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * One tick of the simulation: charge repulsion between every pair of nodes,
 * spring attraction along edges toward `linkDistance`, and weak centering
 * gravity so disconnected components don't drift off-canvas. Pure — returns
 * a new node array. `alpha` (1 down to ~0) is a cooling factor that scales
 * every force so motion damps out over successive calls.
 *
 * O(n^2) in the repulsion term; the caller (`buildMemoryGraph`) already caps
 * the graph at 500 nodes, so a full run stays well under a second.
 */
export function stepSimulation(
  nodes: SimNode[],
  edges: MemoryGraphEdge[],
  alpha: number,
  opts: ForceOptions,
): SimNode[] {
  const { width, height } = opts;
  const chargeStrength = opts.chargeStrength ?? DEFAULT_CHARGE;
  const linkDistance = opts.linkDistance ?? DEFAULT_LINK_DISTANCE;
  const linkStrength = opts.linkStrength ?? DEFAULT_LINK_STRENGTH;
  const centerStrength = opts.centerStrength ?? DEFAULT_CENTER_STRENGTH;
  const damping = opts.damping ?? DEFAULT_DAMPING;

  const n = nodes.length;
  const fx = new Array(n).fill(0);
  const fy = new Array(n).fill(0);
  const indexOf = new Map(nodes.map((node, i) => [node.id, i]));

  // Pairwise repulsion. Two nodes landing exactly on top of each other get a
  // tiny deterministic nudge (index-derived, not random) so the force
  // direction is well-defined instead of NaN.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[i].x - nodes[j].x;
      let dy = nodes[i].y - nodes[j].y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.0001) {
        dx = (i - j) * 0.01 + 0.01;
        dy = (j - i) * 0.01 + 0.01;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = (chargeStrength * alpha) / distSq;
      const fxi = (dx / dist) * force;
      const fyi = (dy / dist) * force;
      fx[i] += fxi;
      fy[i] += fyi;
      fx[j] -= fxi;
      fy[j] -= fyi;
    }
  }

  // Link springs.
  for (const edge of edges) {
    const i = indexOf.get(edge.from);
    const j = indexOf.get(edge.to);
    if (i === undefined || j === undefined || i === j) continue;
    const dx = nodes[j].x - nodes[i].x;
    const dy = nodes[j].y - nodes[i].y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const diff = (dist - linkDistance) * linkStrength * alpha;
    const fxi = (dx / dist) * diff;
    const fyi = (dy / dist) * diff;
    fx[i] += fxi;
    fy[i] += fyi;
    fx[j] -= fxi;
    fy[j] -= fyi;
  }

  // Weak centering gravity.
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < n; i++) {
    fx[i] += (cx - nodes[i].x) * centerStrength * alpha;
    fy[i] += (cy - nodes[i].y) * centerStrength * alpha;
  }

  const margin = 16;
  return nodes.map((node, i) => {
    const vx = (node.vx + fx[i]) * damping;
    const vy = (node.vy + fy[i]) * damping;
    return {
      id: node.id,
      x: clamp(node.x + vx, margin, Math.max(margin, width - margin)),
      y: clamp(node.y + vy, margin, Math.max(margin, height - margin)),
      vx,
      vy,
    };
  });
}

/**
 * Runs the simulation to (near) rest and returns final positions keyed by
 * node id. Iteration count is capped at `maxIterations` regardless of graph
 * size (the 500-node upstream cap keeps a single run fast, but this bound is
 * what keeps it responsive even if that assumption is ever violated), and
 * alpha decays exponentially from 1 toward ~0.001 (same schedule as
 * d3-force's default), so the loop also exits early once motion is
 * negligible.
 */
export function runSimulation(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  width: number,
  height: number,
  maxIterations = 220,
): Map<string, { x: number; y: number }> {
  let sim = initialLayout(nodes, width, height);
  if (sim.length === 0) return new Map();

  let alpha = 1;
  const alphaMin = 0.001;
  const alphaDecay = 1 - Math.pow(alphaMin, 1 / maxIterations);
  const opts: ForceOptions = { width, height };

  for (let iter = 0; iter < maxIterations && alpha > alphaMin; iter++) {
    const next = stepSimulation(sim, edges, alpha, opts);
    let movement = 0;
    for (let i = 0; i < next.length; i++) {
      movement += Math.abs(next[i].x - sim[i].x) + Math.abs(next[i].y - sim[i].y);
    }
    sim = next;
    alpha *= 1 - alphaDecay;
    if (movement / sim.length < 0.02) break;
  }

  const withRadii = sim.map((node, i) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    r: nodeRadius(nodeShapeKind(nodes[i]), nodeDegree(node.id, edges)),
  }));
  const resolved = resolveOverlaps(withRadii);
  const clamped = new Map<string, { x: number; y: number }>();
  for (const [id, p] of resolved) {
    clamped.set(id, { x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) });
  }
  return clamped;
}

/**
 * Post-simulation overlap-resolution pass: pushes apart any node pair whose
 * circles overlap by more than `minGap`, ignoring spring/charge forces (the
 * simulation already ran those to rest). A handful of passes resolves local
 * crowding the O(n^2) force simulation didn't fully iron out, without
 * re-running the whole simulation loop.
 */
export function resolveOverlaps(
  positions: Array<{ id: string; x: number; y: number; r: number }>,
  minGap = 2,
  iterations = 4,
): Map<string, { x: number; y: number }> {
  const pts = positions.map((p) => ({ ...p }));
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + minGap;
        if (dist >= minDist) continue;
        if (dist < 0.0001) {
          dx = (i - j) * 0.01 + 0.01;
          dy = (j - i) * 0.01 + 0.01;
          dist = Math.hypot(dx, dy);
        }
        const overlap = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * overlap;
        a.y -= uy * overlap;
        b.x += ux * overlap;
        b.y += uy * overlap;
      }
    }
  }
  return new Map(pts.map((p) => [p.id, { x: p.x, y: p.y }]));
}

// ─── Zoom / pan / fit-to-content ─────────────────────────────────────────────

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FIT_NODE_MARGIN = 16;

/**
 * Computes an SVG `viewBox` tightly wrapping a set of laid-out node
 * positions, so the initial render has no dead space around a small or
 * clustered graph. `pad` is extra breathing room as a fraction of the
 * content's bounding-box size (on top of a fixed per-node margin so node
 * glyphs at the edge don't get visually clipped).
 */
export function fitViewBox(points: Array<{ x: number; y: number }>, pad = 0.1): ViewBox {
  if (points.length === 0) return { x: 0, y: 0, width: 100, height: 100 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  minX -= FIT_NODE_MARGIN;
  minY -= FIT_NODE_MARGIN;
  const width = Math.max(1, maxX - minX + FIT_NODE_MARGIN * 2);
  const height = Math.max(1, maxY - minY + FIT_NODE_MARGIN * 2);
  const padX = width * pad;
  const padY = height * pad;

  return { x: minX - padX, y: minY - padY, width: width + padX * 2, height: height + padY * 2 };
}

/**
 * Zooms a viewBox around a fixed point (in the *current* viewBox's user-space
 * coordinates — typically the cursor position), clamped so the resulting
 * width stays within `limits`. `factor > 1` zooms in (shrinks the viewBox);
 * `factor < 1` zooms out.
 */
export function zoomViewBox(
  vb: ViewBox,
  factor: number,
  cx: number,
  cy: number,
  limits: { minWidth: number; maxWidth: number },
): ViewBox {
  const desiredWidth = vb.width / factor;
  const width = clamp(desiredWidth, limits.minWidth, limits.maxWidth);
  const actualFactor = vb.width / width;
  const height = vb.height / actualFactor;

  const x = cx - (cx - vb.x) / actualFactor;
  const y = cy - (cy - vb.y) / actualFactor;

  return { x, y, width, height };
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/** All ancestor directory paths of a file path, shallowest first. Used to
 * expand the file tree so a graph-triggered "open file" is actually visible. */
export function ancestorDirPaths(path: string): string[] {
  const segments = path.split('/');
  const dirs: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    dirs.push(segments.slice(0, i + 1).join('/'));
  }
  return dirs;
}
