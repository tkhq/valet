/**
 * Memory graph view — the V1 explorer's Graph tab, reimagined for V2's
 * calm-companion surface. Data comes from `GET /api/memory/graph` (derived
 * server-side per request; V2 stores no links table). Rendering follows
 * V1's key design call: the label IS the node — small colored dots anchor
 * readable label chips instead of degree-sized blobs — with a hover
 * spotlight that fades everything outside the hovered neighborhood.
 *
 * Layout is a synchronous d3-force pass (the graph is static per fetch;
 * live simulation buys nothing but jitter), then panned/zoomed via the
 * same xyflow canvas the workflow surfaces already use.
 */
import { useMemo, useState } from "react";
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

// ─── Layout ──────────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Synchronous force layout — ~300 ticks to convergence, deterministic for
 * a given node order (d3's phyllotaxis initial placement, no randomness). */
export function layoutGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): Map<string, { x: number; y: number }> {
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id }));
  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({ source: e.from, target: e.to }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(80)
        .strength(0.4),
    )
    .force("charge", forceManyBody().strength(-220))
    .force("collide", forceCollide(34))
    .force("x", forceX(0).strength(0.05))
    .force("y", forceY(0).strength(0.05))
    .stop();

  sim.tick(300);

  const out = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return out;
}

// ─── Node renderer ───────────────────────────────────────────────────────

interface GraphNodeData extends Record<string, unknown> {
  node: MemoryGraphNode;
  dimmed: boolean;
  emphasized: boolean;
}

function shortLabel(node: MemoryGraphNode): string {
  const source = node.title || node.path || node.id;
  const base = source.split("/").pop() ?? source;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function GraphDot({ data }: NodeProps<Node<GraphNodeData>>) {
  const { node, dimmed, emphasized } = data;
  const color = node.topDir !== undefined && node.topDir !== "" ? dirDotHex(node.topDir) : "#64748b";

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 transition-opacity duration-150",
        dimmed ? "opacity-15" : "opacity-100",
      )}
    >
      <Handle type="target" position={Position.Top} className="!invisible !h-0 !w-0 !min-h-0 !min-w-0" />
      <Handle type="source" position={Position.Bottom} className="!invisible !h-0 !w-0 !min-h-0 !min-w-0" />
      {node.kind === "dir" ? (
        <span
          className="h-3.5 w-3.5 rounded-sm border-2 bg-paper"
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
          className={cn("rounded-full", emphasized ? "h-3 w-3" : "h-2.5 w-2.5")}
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "max-w-[140px] truncate rounded px-1 text-[10px] leading-tight",
          node.kind === "phantom" ? "italic text-muted" : "text-ink",
          emphasized && "bg-paper font-medium shadow-sm",
        )}
      >
        {shortLabel(node)}
      </span>
    </div>
  );
}

const nodeTypes = { memoryDot: GraphDot };

// ─── Canvas ──────────────────────────────────────────────────────────────

export function MemoryGraphCanvas() {
  const navigate = useNavigate();
  const graphQ = useQuery({ queryKey: ["memory", "graph"], queryFn: () => api.getMemoryGraph() });
  const [filters, setFilters] = useState<GraphFilters>({ journal: false, folders: true });
  const [hoverId, setHoverId] = useState<string | null>(null);

  const filtered = useMemo(
    () => (graphQ.data ? filterGraph(graphQ.data, filters) : { nodes: [], edges: [] }),
    [graphQ.data, filters],
  );

  const positions = useMemo(() => layoutGraph(filtered.nodes, filtered.edges), [filtered]);

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
          dimmed: spotlight !== null && !spotlight.has(n.id),
          emphasized: spotlight !== null && spotlight.has(n.id),
        },
        draggable: false,
        connectable: false,
      })),
    [filtered.nodes, positions, spotlight],
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
              ? { stroke: "#94a3b8", strokeDasharray: "2 4", opacity: faded ? 0.04 : 0.25 }
              : { stroke: "#64748b", opacity: faded ? 0.05 : inSpotlight ? 0.8 : 0.35 },
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
        onNodeMouseEnter={(_, node) => setHoverId(node.id)}
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
    </div>
  );
}
