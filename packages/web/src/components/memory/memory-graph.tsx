/**
 * Memory graph view — the V1 explorer's Graph tab, reimagined for V2's
 * calm-companion surface. Data comes from `GET /api/memory/graph` (derived
 * server-side per request; V2 stores no links table). Rendering follows
 * V1's key design call: the label IS the node — small colored dots anchor
 * readable label chips instead of degree-sized blobs — with two additions
 * from the usability pass:
 *
 *   - dot AREA encodes incoming link count (the closest stored proxy for
 *     "how much the assistant leans on this file");
 *   - the force layout clusters files around per-directory anchors on a
 *     ring, so color groups are spatially coherent instead of shuffled.
 *
 * On large graphs only well-linked nodes keep persistent labels; the rest
 * reveal theirs in the hover spotlight. Hover is suppressed while the
 * viewport is panning/zooming — nodes sliding under a stationary cursor
 * otherwise rapid-fire enter/leave and the whole canvas strobes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { api } from "~/api/client";
import { useMemoryDoc, useMemoryTree } from "~/api/memory";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphResponse } from "~/api/memory-types";
import { Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";
import { stripMarkdown } from "~/lib/strip-markdown";
import { dirDotHex } from "./memory-tree";

// ─── Pure graph filtering (testable) ────────────────────────────────────

export interface GraphFilters {
  /** Include journal/* concepts. Off by default — 88 daily entries chained
   * to one hub is a hairball, not information. */
  journal: boolean;
  /** Include directory hubs + containment edges. */
  folders: boolean;
}

/** Apply view filters, then prune dir/phantom nodes left with no edges —
 * a hub with nothing to hold is noise. */
export function filterGraph(graph: MemoryGraphResponse, filters: GraphFilters): MemoryGraphResponse {
  let nodes = graph.nodes;
  let edges = graph.edges;

  if (!filters.journal) {
    nodes = nodes.filter((n) => !(n.kind === "concept" && n.topDir === "journal"));
  }
  if (!filters.folders) {
    nodes = nodes.filter((n) => n.kind !== "dir");
    edges = edges.filter((e) => e.kind !== "containment");
  }

  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  nodes = nodes.filter((n) => n.kind === "concept" || (degree.get(n.id) ?? 0) > 0);
  const prunedIds = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => prunedIds.has(e.from) && prunedIds.has(e.to));

  return { nodes, edges };
}

/** Precomputed hover lookups. Edge ids follow the flow-edge scheme
 * `${kind}:${index}` — `buildHoverIndex` and the `flowEdges` memo must
 * iterate the same edge array. */
export interface HoverIndex {
  /** node id → neighbor node ids (any edge kind). */
  neighbors: Map<string, string[]>;
  /** node id → ids of edges incident to it. */
  incidentEdges: Map<string, string[]>;
}

export function buildHoverIndex(edges: MemoryGraphEdge[]): HoverIndex {
  const neighbors = new Map<string, string[]>();
  const incidentEdges = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  edges.forEach((e, i) => {
    const edgeId = `${e.kind}:${i}`;
    push(neighbors, e.from, e.to);
    push(neighbors, e.to, e.from);
    push(incidentEdges, e.from, edgeId);
    push(incidentEdges, e.to, edgeId);
  });
  return { neighbors, incidentEdges };
}

// ─── Metrics: size + label policy (testable) ────────────────────────────

/** Incoming `link`-edge count per node id. */
export function linkInDegree(edges: MemoryGraphEdge[]): Map<string, number> {
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== "link") continue;
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return inDeg;
}

/** Dot diameter in px — area ∝ incoming links, bounded so a hub never
 * becomes a blob (V1's explicit anti-pattern). */
export function dotSize(inLinks: number): number {
  return Math.min(26, Math.round(9 + 3.4 * Math.sqrt(inLinks)));
}

/** Above this many nodes, only well-linked nodes keep persistent labels. */
export const LABEL_ALL_MAX = 60;
/** Persistent-label threshold on large graphs (incoming links). */
export const LABEL_MIN_IN_LINKS = 3;

/** Which node ids get an always-visible label. Small graphs label
 * everything; large graphs label dir hubs and well-linked concepts, and
 * everything else reveals its label in the hover spotlight. */
export function persistentLabelIds(
  nodes: MemoryGraphNode[],
  inDeg: Map<string, number>,
): Set<string> {
  if (nodes.length <= LABEL_ALL_MAX) return new Set(nodes.map((n) => n.id));
  const ids = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "dir") ids.add(n.id);
    else if ((inDeg.get(n.id) ?? 0) >= LABEL_MIN_IN_LINKS) ids.add(n.id);
  }
  return ids;
}

// ─── Layout ──────────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
  anchorX: number;
  anchorY: number;
  collideR: number;
}

/**
 * Synchronous force layout, ~300 ticks — deterministic for a given node
 * order (d3's phyllotaxis initial placement, no randomness). Every node is
 * pulled gently toward its directory's anchor on a ring around the origin,
 * which keeps each color family spatially together; links still pull
 * cross-directory references adjacent.
 */
export function layoutGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  inDeg?: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const dirList = [...new Set(nodes.map((n) => n.topDir ?? "").filter((d) => d !== ""))].sort();
  const ringRadius = Math.max(260, 40 * Math.sqrt(nodes.length));
  const anchors = new Map<string, { x: number; y: number }>();
  if (dirList.length > 1) {
    dirList.forEach((dir, i) => {
      const angle = (2 * Math.PI * i) / dirList.length;
      anchors.set(dir, { x: ringRadius * Math.cos(angle), y: ringRadius * Math.sin(angle) });
    });
  }

  const simNodes: SimNode[] = nodes.map((n) => {
    const anchor = anchors.get(n.topDir ?? "") ?? { x: 0, y: 0 };
    const size = dotSize(inDeg?.get(n.id) ?? 0);
    return { id: n.id, anchorX: anchor.x, anchorY: anchor.y, collideR: size / 2 + 26 };
  });
  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({ source: e.from, target: e.to }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(70)
        .strength(0.2),
    )
    .force("charge", forceManyBody().strength(-320))
    .force("collide", forceCollide<SimNode>((d) => d.collideR))
    .force("x", forceX<SimNode>((d) => d.anchorX).strength(0.14))
    .force("y", forceY<SimNode>((d) => d.anchorY).strength(0.14))
    .stop();

  sim.tick(300);

  const out = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return out;
}

// ─── Node renderer ───────────────────────────────────────────────────────

interface GraphNodeData extends Record<string, unknown> {
  node: MemoryGraphNode;
  size: number;
  labelAlways: boolean;
}

function shortLabel(node: MemoryGraphNode): string {
  const source = node.title || node.path || node.id;
  const base = source.split("/").pop() ?? source;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * Static renderer — the hover spotlight never re-renders this. Emphasis
 * and dimming come from the `.mg-spot` / `.mg-hot` classes toggled
 * imperatively on the xyflow DOM (see SPOTLIGHT_CSS); React state changes
 * on every mouse enter/leave were re-rendering ~275 nodes + ~1200 edges
 * per toggle, which read as whole-canvas flashing when sweeping the
 * cursor across the graph.
 */
function GraphDot({ data }: NodeProps<Node<GraphNodeData>>) {
  const { node, size, labelAlways } = data;
  const color = node.topDir !== undefined && node.topDir !== "" ? dirDotHex(node.topDir) : "#64748b";

  return (
    <div className="flex flex-col items-center gap-1">
      <Handle type="target" position={Position.Top} className="!invisible !h-0 !w-0 !min-h-0 !min-w-0" />
      <Handle type="source" position={Position.Bottom} className="!invisible !h-0 !w-0 !min-h-0 !min-w-0" />
      {node.kind === "dir" ? (
        <span
          className="h-4 w-4 rounded-sm border-2 bg-paper"
          style={{ borderColor: color }}
          aria-hidden="true"
        />
      ) : node.kind === "phantom" ? (
        <span
          className="h-2.5 w-2.5 rounded-full border border-dashed border-neutral-400 bg-transparent"
          aria-hidden="true"
        />
      ) : (
        <span
          className="rounded-full"
          style={{ backgroundColor: color, width: size, height: size }}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "mg-label max-w-[150px] truncate rounded px-1 text-[10px] leading-tight",
          node.kind === "phantom" ? "italic text-muted" : "text-ink",
          !labelAlways && "invisible",
        )}
      >
        {shortLabel(node)}
      </span>
    </div>
  );
}

const nodeTypes = { memoryDot: GraphDot };

/** Hover stays suppressed this long after the last pan/zoom event —
 * nodes sliding under a stationary cursor otherwise strobe the fade. */
const HOVER_RESUME_MS = 200;
/** The cursor must rest on a node this long before the spotlight engages
 * (hover intent) — sweeping across the graph triggers nothing. */
const HOVER_ENGAGE_MS = 150;
/** Grace period after leaving a node before the spotlight clears, so
 * moving between a node and its neighbor doesn't blink. */
const HOVER_CLEAR_MS = 150;

const CARD_WIDTH = 288;

/**
 * Hover info card — metadata immediately (from the tree query, already
 * cached), content preview async via the doc query. `pointer-events-none`
 * so the card never steals the hover and flickers the spotlight.
 */
function MemoryHoverCard({
  node,
  x,
  y,
  meta,
  inLinks,
}: {
  node: MemoryGraphNode;
  x: number;
  y: number;
  meta?: { updatedAt: number; pinned: boolean; type: string };
  inLinks: number;
}) {
  const docQ = useMemoryDoc(node.path ?? "", { enabled: node.path !== undefined, staleTime: 60_000 });
  const preview =
    docQ.data?.file?.content !== undefined
      ? stripMarkdown(docQ.data.file.content).slice(0, 280)
      : null;
  const color = node.topDir ? dirDotHex(node.topDir) : "#64748b";

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-line bg-paper shadow-lg"
      style={{ left: x, top: y, width: CARD_WIDTH }}
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="truncate text-sm font-medium text-ink">{node.title || node.path}</span>
          {meta?.pinned && <span aria-hidden="true">📌</span>}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted">{node.path}</div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
          {meta?.type && <span className="rounded bg-ink-wash px-1 py-px">{meta.type}</span>}
          <span>{inLinks} incoming link{inLinks === 1 ? "" : "s"}</span>
          {meta && <span>updated {relativeTime(meta.updatedAt)}</span>}
        </div>
      </div>
      <div className="border-t border-line px-3 py-2 text-xs leading-snug text-muted">
        {preview === null && (
          <span className="flex items-center gap-1.5">
            <Spinner size={11} /> Loading preview…
          </span>
        )}
        {preview !== null && (
          <span className="line-clamp-4 whitespace-pre-line text-ink">{preview || "(empty file)"}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Spotlight styling, applied via container classes instead of React
 * state. Edge base opacity is an inline style, so the edge rules need
 * !important; the node rules win on specificity alone.
 */
const SPOTLIGHT_CSS = `
.mg-canvas .react-flow__node { transition: opacity 160ms ease; }
.mg-spot .react-flow__node { opacity: 0.25; }
.mg-spot .react-flow__node.mg-hot { opacity: 1; }
.mg-spot .react-flow__edge { opacity: 0.06 !important; }
.mg-spot .react-flow__edge.mg-hot { opacity: 0.9 !important; }
.mg-spot .react-flow__node.mg-hot .mg-label {
  visibility: visible;
  background: var(--paper);
  font-weight: 500;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);
}
`;

// ─── Canvas ──────────────────────────────────────────────────────────────

export function MemoryGraphCanvas() {
  const navigate = useNavigate();
  const graphQ = useQuery({ queryKey: ["memory", "graph"], queryFn: () => api.getMemoryGraph() });
  const [filters, setFilters] = useState<GraphFilters>({ journal: false, folders: true });
  // Timestamp of the last viewport move, not a boolean: programmatic moves
  // (the initial fitView) can fire onMoveStart without a matching
  // onMoveEnd, and a stuck flag would gate hover forever. A timestamp
  // self-heals — hover resumes HOVER_RESUME_MS after the last move event.
  const lastMoveTs = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const engageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hover card is React state, but it lives OUTSIDE the flow — the
  // memoized node/edge arrays don't depend on it, so showing/hiding it
  // never re-renders the canvas contents.
  const [hoverCard, setHoverCard] = useState<{ node: MemoryGraphNode; x: number; y: number } | null>(null);
  const treeQ = useMemoryTree();

  const filtered = useMemo(
    () => (graphQ.data ? filterGraph(graphQ.data, filters) : { nodes: [], edges: [] }),
    [graphQ.data, filters],
  );

  const inDeg = useMemo(() => linkInDegree(filtered.edges), [filtered.edges]);
  const labeled = useMemo(() => persistentLabelIds(filtered.nodes, inDeg), [filtered.nodes, inDeg]);
  const positions = useMemo(() => layoutGraph(filtered.nodes, filtered.edges, inDeg), [filtered, inDeg]);
  const hoverIndex = useMemo(() => buildHoverIndex(filtered.edges), [filtered.edges]);
  // Hover-card metadata — the tree query is cached from the Files pane.
  const metaByPath = useMemo(() => {
    const map = new Map<string, { updatedAt: number; pinned: boolean; type: string }>();
    for (const e of treeQ.data?.entries ?? []) {
      map.set(e.path, { updatedAt: e.updatedAt, pinned: e.pinned, type: e.type });
    }
    return map;
  }, [treeQ.data]);

  const flowNodes: Node<GraphNodeData>[] = useMemo(
    () =>
      filtered.nodes.map((n) => ({
        id: n.id,
        type: "memoryDot",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          node: n,
          size: dotSize(inDeg.get(n.id) ?? 0),
          labelAlways: labeled.has(n.id),
        },
        draggable: false,
        connectable: false,
      })),
    [filtered.nodes, positions, inDeg, labeled],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      filtered.edges.map((e, i) => ({
        id: `${e.kind}:${i}`,
        source: e.from,
        target: e.to,
        type: "straight",
        focusable: false,
        style:
          e.kind === "containment"
            ? { stroke: "#94a3b8", strokeDasharray: "2 4", opacity: 0.16 }
            : { stroke: "#64748b", opacity: 0.22 },
      })),
    [filtered.edges],
  );

  // ── Imperative spotlight — never re-renders the flow ──────────────────

  function clearSpotlight() {
    const c = containerRef.current;
    if (!c) return;
    c.classList.remove("mg-spot");
    for (const el of c.querySelectorAll(".mg-hot")) el.classList.remove("mg-hot");
    setHoverCard(null); // no-op re-render when already null
  }

  function applySpotlight(id: string) {
    const c = containerRef.current;
    if (!c) return;
    for (const el of c.querySelectorAll(".mg-hot")) el.classList.remove("mg-hot");
    c.classList.add("mg-spot");
    const hotNodes = [id, ...(hoverIndex.neighbors.get(id) ?? [])];
    for (const nodeId of hotNodes) {
      c.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)?.classList.add("mg-hot");
    }
    for (const edgeId of hoverIndex.incidentEdges.get(id) ?? []) {
      c.querySelector(`.react-flow__edge[data-id="${CSS.escape(edgeId)}"]`)?.classList.add("mg-hot");
    }

    // Info card, concept nodes only — anchored beside the node's screen
    // rect, flipped left when it would overflow the container.
    const graphNode = filtered.nodes.find((n) => n.id === id);
    if (graphNode?.kind !== "concept") {
      setHoverCard(null);
      return;
    }
    const nodeEl = c.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    if (!nodeEl) {
      setHoverCard(null);
      return;
    }
    const nodeRect = nodeEl.getBoundingClientRect();
    const cRect = c.getBoundingClientRect();
    let x = nodeRect.right - cRect.left + 12;
    if (x + CARD_WIDTH > cRect.width - 8) x = nodeRect.left - cRect.left - CARD_WIDTH - 12;
    const y = Math.min(Math.max(8, nodeRect.top - cRect.top), Math.max(8, cRect.height - 190));
    setHoverCard({ node: graphNode, x, y });
  }

  function cancelTimers() {
    if (engageTimer.current !== null) clearTimeout(engageTimer.current);
    if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    engageTimer.current = null;
    clearTimer.current = null;
  }

  function onEnterNode(id: string) {
    if (performance.now() - lastMoveTs.current < HOVER_RESUME_MS) return;
    cancelTimers();
    const alreadySpotlighting = containerRef.current?.classList.contains("mg-spot") ?? false;
    if (alreadySpotlighting) {
      applySpotlight(id); // re-target instantly when walking between neighbors
    } else {
      engageTimer.current = setTimeout(() => applySpotlight(id), HOVER_ENGAGE_MS);
    }
  }

  function onLeaveNode() {
    cancelTimers();
    clearTimer.current = setTimeout(clearSpotlight, HOVER_CLEAR_MS);
  }

  // Filters change → xyflow remounts nodes → stale mg-hot classes vanish
  // with them, but the container's mg-spot must go too.
  useEffect(() => {
    clearSpotlight();
    return cancelTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  if (graphQ.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Spinner size={16} /> Building graph…
      </div>
    );
  }
  if (graphQ.error) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-danger-500">
        Couldn't load the memory graph.{" "}
        <button type="button" className="ml-1 underline" onClick={() => graphQ.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (filtered.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Nothing to graph yet.
      </div>
    );
  }

  const conceptCount = filtered.nodes.filter((n) => n.kind === "concept").length;
  const linkCount = filtered.edges.filter((e) => e.kind === "link").length;
  const legendDirs = [...new Set(
    filtered.nodes
      .filter((n) => n.kind === "concept" && n.topDir)
      .map((n) => n.topDir as string),
  )].sort();
  const hasPhantoms = filtered.nodes.some((n) => n.kind === "phantom");

  return (
    <div ref={containerRef} className="mg-canvas relative flex-1 min-h-0">
      <style>{SPOTLIGHT_CSS}</style>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onMove={() => {
          lastMoveTs.current = performance.now();
          cancelTimers();
          clearSpotlight();
        }}
        onNodeMouseEnter={(_, node) => onEnterNode(node.id)}
        onNodeMouseLeave={() => onLeaveNode()}
        onNodeClick={(_, node) => {
          const data = node.data as GraphNodeData;
          if (data.node.kind === "concept" && data.node.path) {
            void navigate({ to: "/memory/$", params: { _splat: data.node.path } });
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="opacity-40" />
      </ReactFlow>

      {hoverCard && (
        <MemoryHoverCard
          node={hoverCard.node}
          x={hoverCard.x}
          y={hoverCard.y}
          meta={hoverCard.node.path !== undefined ? metaByPath.get(hoverCard.node.path) : undefined}
          inLinks={inDeg.get(hoverCard.node.id) ?? 0}
        />
      )}

      <div className="absolute right-3 top-3 rounded-md border border-line bg-paper/95 px-3 py-2 text-xs shadow-sm">
        <div className="mb-1.5 text-muted">
          {conceptCount} files · {linkCount} links
        </div>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={filters.journal}
            onChange={(e) => setFilters((f) => ({ ...f, journal: e.target.checked }))}
          />
          Journal
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={filters.folders}
            onChange={(e) => setFilters((f) => ({ ...f, folders: e.target.checked }))}
          />
          Folders
        </label>
      </div>

      <div className="absolute bottom-3 left-3 max-h-64 overflow-y-auto rounded-md border border-line bg-paper/95 px-3 py-2 text-xs shadow-sm">
        <div className="space-y-1">
          {legendDirs.map((dir) => (
            <div key={dir} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: dirDotHex(dir) }}
                aria-hidden="true"
              />
              <span className="text-ink">{dir}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-1 border-t border-line pt-2 text-muted">
          {filters.folders && (
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 shrink-0 rounded-sm border-2 border-neutral-400 bg-paper" aria-hidden="true" />
              folder
            </div>
          )}
          {hasPhantoms && (
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-neutral-400" aria-hidden="true" />
              missing file
            </div>
          )}
          <div>dot size = incoming links</div>
        </div>
      </div>
    </div>
  );
}
