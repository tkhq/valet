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
import { useMemo, useRef, useState } from "react";
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
import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphResponse } from "~/api/memory-types";
import { Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
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

/** Node ids adjacent to `id` (any edge kind), plus `id` itself — the hover
 * spotlight set. */
export function spotlightSet(id: string, edges: MemoryGraphEdge[]): Set<string> {
  const set = new Set([id]);
  for (const e of edges) {
    if (e.from === id) set.add(e.to);
    if (e.to === id) set.add(e.from);
  }
  return set;
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
  dimmed: boolean;
  emphasized: boolean;
}

function shortLabel(node: MemoryGraphNode): string {
  const source = node.title || node.path || node.id;
  const base = source.split("/").pop() ?? source;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function GraphDot({ data }: NodeProps<Node<GraphNodeData>>) {
  const { node, size, labelAlways, dimmed, emphasized } = data;
  const color = node.topDir !== undefined && node.topDir !== "" ? dirDotHex(node.topDir) : "#64748b";
  const showLabel = labelAlways || emphasized;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 transition-opacity duration-150",
        dimmed ? "opacity-30" : "opacity-100",
      )}
    >
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
          style={{
            backgroundColor: color,
            width: size,
            height: size,
            boxShadow: emphasized ? `0 0 0 3px ${color}33` : undefined,
          }}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "max-w-[150px] truncate rounded px-1 text-[10px] leading-tight",
          node.kind === "phantom" ? "italic text-muted" : "text-ink",
          emphasized && "bg-paper font-medium shadow-sm",
          !showLabel && "invisible",
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

// ─── Canvas ──────────────────────────────────────────────────────────────

export function MemoryGraphCanvas() {
  const navigate = useNavigate();
  const graphQ = useQuery({ queryKey: ["memory", "graph"], queryFn: () => api.getMemoryGraph() });
  const [filters, setFilters] = useState<GraphFilters>({ journal: false, folders: true });
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Timestamp of the last viewport move, not a boolean: programmatic moves
  // (the initial fitView) can fire onMoveStart without a matching
  // onMoveEnd, and a stuck flag would gate hover forever. A timestamp
  // self-heals — hover resumes HOVER_RESUME_MS after the last move event.
  const lastMoveTs = useRef(0);

  const filtered = useMemo(
    () => (graphQ.data ? filterGraph(graphQ.data, filters) : { nodes: [], edges: [] }),
    [graphQ.data, filters],
  );

  const inDeg = useMemo(() => linkInDegree(filtered.edges), [filtered.edges]);
  const labeled = useMemo(() => persistentLabelIds(filtered.nodes, inDeg), [filtered.nodes, inDeg]);
  const positions = useMemo(() => layoutGraph(filtered.nodes, filtered.edges, inDeg), [filtered, inDeg]);

  const spotlight = useMemo(
    () => (hoverId !== null ? spotlightSet(hoverId, filtered.edges) : null),
    [hoverId, filtered.edges],
  );

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
          dimmed: spotlight !== null && !spotlight.has(n.id),
          emphasized: spotlight !== null && spotlight.has(n.id),
        },
        draggable: false,
        connectable: false,
      })),
    [filtered.nodes, positions, inDeg, labeled, spotlight],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      filtered.edges.map((e, i) => {
        const inSpotlight = spotlight !== null && spotlight.has(e.from) && spotlight.has(e.to);
        const faded = spotlight !== null && !inSpotlight;
        return {
          id: `${e.kind}:${i}`,
          source: e.from,
          target: e.to,
          type: "straight",
          focusable: false,
          style:
            e.kind === "containment"
              ? { stroke: "#94a3b8", strokeDasharray: "2 4", opacity: faded ? 0.06 : 0.16 }
              : { stroke: "#64748b", opacity: faded ? 0.08 : inSpotlight ? 0.8 : 0.22 },
        };
      }),
    [filtered.edges, spotlight],
  );

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
    <div className="relative flex-1 min-h-0">
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
          // No-op when already null (React bails on identical state), so
          // this doesn't re-render on every pan frame.
          setHoverId(null);
        }}
        onNodeMouseEnter={(_, node) => {
          if (performance.now() - lastMoveTs.current > HOVER_RESUME_MS) setHoverId(node.id);
        }}
        onNodeMouseLeave={() => setHoverId(null)}
        onNodeClick={(_, node) => {
          const data = node.data as GraphNodeData;
          if (data.node.kind === "concept" && data.node.path) {
            void navigate({ to: "/memory/$", params: { _splat: data.node.path } });
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="opacity-40" />
      </ReactFlow>

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
