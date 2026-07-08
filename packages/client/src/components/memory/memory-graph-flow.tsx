import * as React from 'react';
import type { Edge, Node, NodeProps, OnNodeDrag, ReactFlowInstance } from '@xyflow/react';
import { Handle, MiniMap, Position, useNodesState } from '@xyflow/react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { cn } from '@/lib/cn';
import { useMemoryGraph } from '@/api/orchestrator';
import type { MemoryGraphEdge, MemoryGraphNode } from '@/api/types';
import { getDirColor, DEFAULT_DIR_COLOR } from '@/components/orchestrator/memory-explorer-utils';
import {
  isDirectoryNode,
  isPlainTagNode,
  nodeTopDir,
  nodeLabel,
  nodeShortLabel,
  nodeDegree,
  neighborSet,
  linkCounts,
  containmentFileCount,
  filterJournal,
  filterSessionHubs,
  pruneIsolatedDerivedNodes,
  labelText,
} from '@/components/orchestrator/memory-graph-utils';
import { Canvas } from '@/components/ai-elements/canvas';
import { Controls } from '@/components/ai-elements/controls';
import { Panel } from '@/components/ai-elements/panel';
import { Checkbox } from '@/components/ui/checkbox';

// ─── Visual design ──────────────────────────────────────────────────────────
//
// The label IS the node: small dots anchor readable label chips (Obsidian-
// style), instead of big degree-sized blobs whose area carries no meaning a
// user cares about. Hierarchy comes from selection/hover emphasis, not size:
//
// - hover → spotlight the hovered node's neighborhood (rest fades hard)
// - selected file (synced with the detail pane) → soft persistent emphasis
// - hubs (session/resource/directory) are outline shapes, visually quieter
//   than real files even when well-connected

const SESSION_HEX = '#8b5cf6'; // violet — matches the legend
const RESOURCE_HEX = '#0ea5e9'; // sky — matches the legend

// Generic basenames that need their parent directory to be identifiable
// ("overview" ×3 is meaningless; "hellacamping-3/overview" is not).
const GENERIC_BASENAMES = new Set([
  'overview', 'index', 'readme', 'notes', 'status', 'task-status', 'analysis', 'journal', 'log', 'todo',
]);

function dotRadius(node: MemoryGraphNode, degree: number): number {
  switch (node.kind) {
    case 'concept':
      return Math.min(10, 5.5 + degree * 0.6);
    case 'phantom':
      return 5;
    case 'session':
      return 6.5;
    case 'resource':
      return 6.5;
    default:
      return isDirectoryNode(node) ? 8 : 4.5;
  }
}

function nodeHex(node: MemoryGraphNode): string {
  if (node.kind === 'session') return SESSION_HEX;
  if (node.kind === 'resource') return RESOURCE_HEX;
  const topDir = nodeTopDir(node);
  return (topDir ? getDirColor(topDir) : DEFAULT_DIR_COLOR).hex;
}

/** Concept labels disambiguate generic/duplicate basenames with their parent dir. */
function displayLabel(node: MemoryGraphNode, duplicatedBasenames: Set<string>): string {
  if (node.kind === 'concept' && node.path) {
    const base = nodeShortLabel(node);
    if (GENERIC_BASENAMES.has(base.toLowerCase()) || duplicatedBasenames.has(base)) {
      const segments = node.path.split('/');
      const parent = segments.length >= 2 ? segments[segments.length - 2] : '';
      return parent ? `${parent}/${base}` : base;
    }
    return base;
  }
  return labelText(node);
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

type FlowNodeData = {
  gnode: MemoryGraphNode;
  r: number;
  hex: string;
  label: string;
  [key: string]: unknown;
};

// Emphasis state shared with node components without rebuilding every node
// object on each mouse move. Hover is a hard spotlight; selection (the file
// open in the detail pane) is a soft persistent one.
const EmphasisContext = React.createContext<{
  hoveredId: string | null;
  hoverNeighbors: Set<string> | null;
  selectedId: string | null;
  selectedNeighbors: Set<string> | null;
}>({ hoveredId: null, hoverNeighbors: null, selectedId: null, selectedNeighbors: null });

/**
 * Interactive memory knowledge graph: React Flow canvas (shared ai-elements
 * wrappers) over a live d3-force simulation. Nodes are draggable — the graph
 * reacts while dragging and nodes pin where dropped; "Re-layout" unpins
 * everything and reheats. Selection stays in sync with the detail pane.
 */
export function MemoryGraphFlowView({
  onOpenFile,
  selectedPath = null,
  heightClassName = 'h-[460px]',
}: {
  onOpenFile: (path: string) => void;
  selectedPath?: string | null;
  heightClassName?: string;
}) {
  const [showTags, setShowTags] = React.useState(false);
  const [showContainment, setShowContainment] = React.useState(false);
  const [showJournal, setShowJournal] = React.useState(false);
  // Off by default: session co-authorship is a weak signal (one reorg session
  // welds unrelated files together), so it must be asked for, not ambient.
  const [showSessions, setShowSessions] = React.useState(false);
  const [hoverInfo, setHoverInfo] = React.useState<{ id: string; x: number; y: number } | null>(null);

  const { data, isLoading, isError } = useMemoryGraph({ tags: showTags, containment: showContainment });
  const rawNodes = React.useMemo(() => data?.nodes ?? [], [data]);
  const rawEdges = React.useMemo(() => data?.edges ?? [], [data]);
  const truncated = data?.truncated ?? false;

  // Noise control: filter BEFORE the simulation runs, so hidden journal
  // entries / session hubs never influence layout. Derived nodes (phantoms,
  // resource/session hubs) that end up with no visible connections are then
  // pruned — they'd float meaninglessly otherwise.
  const { nodes, edges, hiddenCount } = React.useMemo(() => {
    const journalPass = showJournal
      ? { nodes: rawNodes, edges: rawEdges, hiddenCount: 0 }
      : filterJournal(rawNodes, rawEdges);
    const sessionPass = showSessions
      ? journalPass
      : filterSessionHubs(journalPass.nodes, journalPass.edges);
    const pruned = pruneIsolatedDerivedNodes(sessionPass.nodes, sessionPass.edges);
    return { nodes: pruned.nodes, edges: pruned.edges, hiddenCount: journalPass.hiddenCount };
  }, [rawNodes, rawEdges, showJournal, showSessions]);

  const nodesById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Tooltip counts run against the UNFILTERED graph: a phantom whose only
  // referencers are hidden journal entries must still say who references it.
  const allNodesById = React.useMemo(() => new Map(rawNodes.map((n) => [n.id, n])), [rawNodes]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center text-xs text-neutral-400 dark:text-neutral-600', heightClassName)}>
        Loading graph…
      </div>
    );
  }
  if (isError) {
    return (
      <div className={cn('flex items-center justify-center text-xs text-red-400 dark:text-red-500', heightClassName)}>
        Failed to load memory graph
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-1 text-center', heightClassName)}>
        <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">No graph data yet</p>
        <p className="max-w-xs text-2xs text-neutral-400 dark:text-neutral-600">
          The graph fills in once memory files exist and start linking to each other.
        </p>
      </div>
    );
  }

  return (
    <GraphCanvas
      key={`${showTags}-${showContainment}-${showJournal}-${showSessions}`}
      nodes={nodes}
      edges={edges}
      allEdges={rawEdges}
      nodesById={nodesById}
      allNodesById={allNodesById}
      onOpenFile={onOpenFile}
      selectedPath={selectedPath}
      heightClassName={heightClassName}
      hoverInfo={hoverInfo}
      setHoverInfo={setHoverInfo}
      toggles={
        <>
          <label className="flex items-center gap-1.5 px-1 text-2xs text-neutral-600 dark:text-neutral-400">
            <Checkbox checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />
            Tags
          </label>
          <label className="flex items-center gap-1.5 px-1 text-2xs text-neutral-600 dark:text-neutral-400">
            <Checkbox checked={showContainment} onChange={(e) => setShowContainment(e.target.checked)} />
            Directories
          </label>
          <label className="flex items-center gap-1.5 px-1 text-2xs text-neutral-600 dark:text-neutral-400">
            <Checkbox checked={showJournal} onChange={(e) => setShowJournal(e.target.checked)} />
            Journal
          </label>
          <label
            className="flex items-center gap-1.5 px-1 text-2xs text-neutral-600 dark:text-neutral-400"
            title="Show conversation hubs linking files written in the same session — a weak association, hidden by default"
          >
            <Checkbox checked={showSessions} onChange={(e) => setShowSessions(e.target.checked)} />
            Sessions
          </label>
        </>
      }
      truncated={truncated}
      hiddenCount={showJournal ? 0 : hiddenCount}
    />
  );
}

// ─── Canvas (per filter combination — remounted via key so the sim rebuilds) ─

function GraphCanvas({
  nodes,
  edges,
  allEdges,
  nodesById,
  allNodesById,
  onOpenFile,
  selectedPath,
  heightClassName,
  hoverInfo,
  setHoverInfo,
  toggles,
  truncated,
  hiddenCount,
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  allEdges: MemoryGraphEdge[];
  nodesById: Map<string, MemoryGraphNode>;
  allNodesById: Map<string, MemoryGraphNode>;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  heightClassName: string;
  hoverInfo: { id: string; x: number; y: number } | null;
  setHoverInfo: (v: { id: string; x: number; y: number } | null) => void;
  toggles: React.ReactNode;
  truncated: boolean;
  hiddenCount: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const instanceRef = React.useRef<ReactFlowInstance | null>(null);

  // ── Force layout: settle synchronously once, then keep the simulation
  // around so drags can reheat it. Collision radius reserves horizontal room
  // for the label chip, which is the real footprint of a node.
  const layout = React.useMemo(() => {
    const validIds = new Set(nodes.map((n) => n.id));
    const radiusById = new Map(nodes.map((n) => [n.id, dotRadius(n, nodeDegree(n.id, edges))]));

    // Deterministic circle seed (no Math.random — stable across renders).
    const simNodes: SimNode[] = nodes.map((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const ring = 140 + (i % 5) * 70;
      return { id: n.id, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
    });
    const simLinks = edges
      .filter((e) => validIds.has(e.from) && validIds.has(e.to))
      .map((e) => ({ source: e.from, target: e.to }));

    const sim: Simulation<SimNode, undefined> = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, { source: string; target: string }>(simLinks)
          .id((d) => d.id)
          .distance(110)
          .strength(0.25),
      )
      .force('charge', forceManyBody().strength(-320))
      .force('collide', forceCollide<SimNode>().radius((d) => (radiusById.get(d.id) ?? 6) + 34))
      .force('x', forceX(0).strength(0.035))
      .force('y', forceY(0).strength(0.035));

    sim.stop();
    // Settle fully before first paint (same trick d3 docs use).
    const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
    sim.tick(ticks);

    return { sim, byId: new Map(simNodes.map((s) => [s.id, s])), simNodes, radiusById };
  }, [nodes, edges]);

  const duplicatedBasenames = React.useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of nodes) {
      if (n.kind !== 'concept') continue;
      const base = nodeShortLabel(n);
      seen.set(base, (seen.get(base) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([b]) => b));
  }, [nodes]);

  // Typed as base Node[]: the shared Canvas wrapper (ai-elements) is
  // non-generic, so handlers/state use base Node and resolve graph data
  // through nodesById instead of node.data casts.
  const initialNodes = React.useMemo<Node[]>(
    () =>
      nodes.map((n) => {
        const sn = layout.byId.get(n.id);
        const data: FlowNodeData = {
          gnode: n,
          r: layout.radiusById.get(n.id) ?? 6,
          hex: nodeHex(n),
          label: displayLabel(n, duplicatedBasenames),
        };
        return {
          id: n.id,
          type: 'memory' as const,
          position: { x: sn?.x ?? 0, y: sn?.y ?? 0 },
          draggable: true,
          data,
        };
      }),
    [nodes, layout, duplicatedBasenames],
  );

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>(initialNodes);
  const hexById = React.useMemo(() => new Map(nodes.map((n) => [n.id, nodeHex(n)])), [nodes]);

  // Live sim → React Flow position sync (rAF-throttled so a hot simulation
  // can't outrun the renderer).
  React.useEffect(() => {
    const sim = layout.sim;
    let raf = 0;
    sim.on('tick', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setFlowNodes((prev) =>
          prev.map((fn) => {
            const sn = layout.byId.get(fn.id);
            return sn ? { ...fn, position: { x: sn.x ?? 0, y: sn.y ?? 0 } } : fn;
          }),
        );
      });
    });
    return () => {
      sim.on('tick', null);
      sim.stop();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [layout, setFlowNodes]);

  // ── Drag ⇆ physics: dragging fixes the node under the cursor and reheats
  // the sim so neighbors react; on drop the node stays pinned where left.
  const handleDragStart: OnNodeDrag = (_e, node) => {
    const sn = layout.byId.get(node.id);
    if (!sn) return;
    sn.fx = node.position.x;
    sn.fy = node.position.y;
    layout.sim.alphaTarget(0.25).restart();
  };
  const handleDrag: OnNodeDrag = (_e, node) => {
    const sn = layout.byId.get(node.id);
    if (!sn) return;
    sn.fx = node.position.x;
    sn.fy = node.position.y;
  };
  const handleDragStop = () => {
    layout.sim.alphaTarget(0);
  };

  const relayout = () => {
    for (const sn of layout.simNodes) {
      sn.fx = null;
      sn.fy = null;
    }
    layout.sim.on('end', () => {
      instanceRef.current?.fitView({ padding: 0.1, duration: 300 });
      layout.sim.on('end', null);
    });
    layout.sim.alpha(0.9).restart();
  };

  // ── Emphasis: hover spotlight (hard), pane selection (soft, persistent) ──
  const hoveredId = hoverInfo?.id ?? null;
  const hoverNeighbors = React.useMemo(() => (hoveredId ? neighborSet(hoveredId, edges) : null), [hoveredId, edges]);

  const selectedId = React.useMemo(() => {
    if (!selectedPath) return null;
    for (const n of nodes) {
      if (n.kind === 'concept' && n.path === selectedPath) return n.id;
    }
    return null;
  }, [nodes, selectedPath]);
  const selectedNeighbors = React.useMemo(
    () => (selectedId ? neighborSet(selectedId, edges) : null),
    [selectedId, edges],
  );

  const emphasisCtx = React.useMemo(
    () => ({ hoveredId, hoverNeighbors, selectedId, selectedNeighbors }),
    [hoveredId, hoverNeighbors, selectedId, selectedNeighbors],
  );

  const flowEdges = React.useMemo<Edge[]>(() => {
    const validIds = new Set(nodes.map((n) => n.id));
    return edges
      .filter((e) => validIds.has(e.from) && validIds.has(e.to))
      .map((e, i) => {
        const hoverAdjacent = !!hoveredId && (e.from === hoveredId || e.to === hoveredId);
        const selectedAdjacent = !!selectedId && (e.from === selectedId || e.to === selectedId);
        const baseOpacity = e.kind === 'link' ? 0.3 : e.kind === 'containment' ? 0.18 : 0.14;
        let opacity = baseOpacity;
        if (hoveredId) opacity = hoverAdjacent ? 0.65 : 0.04;
        else if (selectedId) opacity = selectedAdjacent ? 0.55 : 0.08;
        return {
          id: `${e.from}->${e.to}-${i}`,
          source: e.from,
          target: e.to,
          type: 'straight',
          focusable: false,
          selectable: false,
          style: {
            stroke: '#94a3b8',
            strokeOpacity: opacity,
            strokeWidth: hoverAdjacent || selectedAdjacent ? 1.6 : 1.1,
            strokeDasharray: e.kind === 'containment' ? '3 4' : e.kind === 'session' ? '1.5 3' : undefined,
            transition: 'stroke-opacity 120ms ease-out',
          },
        };
      });
  }, [nodes, edges, hoveredId, selectedId]);

  const handleNodeHover = (e: React.MouseEvent, node: Node) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoverInfo({ id: node.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hoveredNode = hoveredId ? nodesById.get(hoveredId) : undefined;

  return (
    <div ref={containerRef} className={cn('relative', heightClassName)}>
      <EmphasisContext.Provider value={emphasisCtx}>
        <Canvas
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={(instance) => {
            instanceRef.current = instance;
          }}
          nodeOrigin={[0.5, 0.5]}
          fitViewOptions={{ padding: 0.1 }}
          minZoom={0.15}
          maxZoom={4}
          deleteKeyCode={null}
          nodesConnectable={false}
          selectNodesOnDrag={false}
          onNodeDragStart={handleDragStart}
          onNodeDrag={handleDrag}
          onNodeDragStop={handleDragStop}
          onNodeMouseEnter={handleNodeHover}
          onNodeMouseMove={handleNodeHover}
          onNodeMouseLeave={() => setHoverInfo(null)}
          onNodeClick={(_e, node) => {
            const g = nodesById.get(node.id);
            if (g?.kind === 'concept' && g.path) onOpenFile(g.path);
          }}
        >
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => hexById.get(n.id) ?? '#a3a3a3'}
            className="!h-24 !w-36 overflow-hidden rounded-md !border !border-neutral-200 !bg-white dark:!border-neutral-700 dark:!bg-neutral-900"
            maskColor="rgb(163 163 163 / 0.12)"
          />

          {/* Filter toggles + re-layout */}
          <Panel position="top-left" className="flex items-center gap-2 p-1.5">
            {toggles}
            <div className="h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
            <button
              type="button"
              onClick={relayout}
              className="rounded px-1.5 py-0.5 text-2xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              title="Unpin all nodes and re-run the force layout"
            >
              Re-layout
            </button>
          </Panel>

          {(truncated || hiddenCount > 0) && (
            <Panel position="top-right" className="space-y-1 border-none bg-transparent p-0 shadow-none dark:bg-transparent">
              {truncated && (
                <div className="rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-400">
                  Graph truncated to 500 nodes
                </div>
              )}
              {hiddenCount > 0 && (
                <div className="rounded-full bg-white/80 px-2 py-0.5 text-right text-2xs text-neutral-400 dark:bg-neutral-900/80 dark:text-neutral-500">
                  {hiddenCount} journal {hiddenCount === 1 ? 'entry' : 'entries'} hidden
                </div>
              )}
            </Panel>
          )}

          <Panel position="bottom-left" className="p-1.5">
            <GraphLegend />
          </Panel>
        </Canvas>
      </EmphasisContext.Provider>

      {hoverInfo && hoveredNode && (
        <GraphTooltip
          node={hoveredNode}
          x={hoverInfo.x}
          y={hoverInfo.y}
          containerRef={containerRef}
          edges={allEdges}
          nodesById={allNodesById}
        />
      )}
    </div>
  );
}

// ─── Custom node ────────────────────────────────────────────────────────────

const hiddenHandleStyle: React.CSSProperties = {
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 0,
  opacity: 0,
  pointerEvents: 'none',
};

function MemoryNode({ data }: NodeProps<Node<FlowNodeData, 'memory'>>) {
  const { hoveredId, hoverNeighbors, selectedId, selectedNeighbors } = React.useContext(EmphasisContext);
  const { gnode, r, hex, label } = data;

  const isSelected = gnode.id === selectedId;
  // Hover spotlight wins; otherwise a soft selection emphasis; otherwise full.
  let opacity = 1;
  if (hoveredId) {
    opacity = gnode.id === hoveredId || hoverNeighbors?.has(gnode.id) ? 1 : 0.1;
  } else if (selectedId) {
    opacity = isSelected || selectedNeighbors?.has(gnode.id) ? 1 : 0.3;
  }

  const clickable = gnode.kind === 'concept' && !!gnode.path;
  const d = r * 2;
  const pad = 6; // hit-area + room for the selection ring

  return (
    <div
      className={cn('relative flex flex-col items-center', clickable ? 'cursor-pointer' : 'cursor-grab')}
      style={{ opacity, transition: 'opacity 120ms ease-out' }}
    >
      <Handle type="target" position={Position.Top} style={hiddenHandleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hiddenHandleStyle} isConnectable={false} />
      <svg
        width={d + pad * 2}
        height={d + pad * 2}
        viewBox={`${-r - pad} ${-r - pad} ${d + pad * 2} ${d + pad * 2}`}
        className="overflow-visible"
      >
        {isSelected && (
          <circle r={r + 4} fill="none" strokeWidth={2} className="stroke-accent" opacity={0.9} />
        )}
        <NodeGlyph node={gnode} hex={hex} r={r} />
      </svg>
      <div
        className={cn(
          'pointer-events-none -mt-0.5 max-w-[160px] truncate rounded px-1 py-px text-center text-[10px] leading-tight backdrop-blur-[1px]',
          'bg-white/75 text-neutral-600 dark:bg-neutral-950/60 dark:text-neutral-300',
          isSelected && 'font-semibold text-neutral-900 dark:text-neutral-100',
        )}
      >
        {label}
      </div>
    </div>
  );
}

const nodeTypes = { memory: MemoryNode };

function NodeGlyph({ node, hex, r }: { node: MemoryGraphNode; hex: string; r: number }) {
  switch (node.kind) {
    case 'concept':
      // Filled dot with a subtle rim so colors read softly on both themes.
      return (
        <>
          <circle r={r} fill={hex} fillOpacity={0.9} />
          <circle r={r} fill="none" stroke={hex} strokeWidth={1} strokeOpacity={0.5} />
        </>
      );
    case 'phantom':
      // Phantom = link target with no backing file yet — a dashed "TODO stub".
      return <circle r={r - 0.5} fill="none" stroke={hex} strokeWidth={1.5} strokeDasharray="2.5 2.5" />;
    case 'session':
      // Diamond outline — a derived conversation hub, not a real memory file.
      return (
        <rect
          x={-r * 0.78}
          y={-r * 0.78}
          width={r * 1.56}
          height={r * 1.56}
          fill={hex}
          fillOpacity={0.15}
          stroke={hex}
          strokeWidth={1.5}
          transform="rotate(45)"
        />
      );
    case 'resource':
      // Rounded-square outline — a derived resource cluster hub.
      return (
        <rect
          x={-r * 0.82}
          y={-r * 0.82}
          width={r * 1.64}
          height={r * 1.64}
          rx={2.5}
          fill={hex}
          fillOpacity={0.15}
          stroke={hex}
          strokeWidth={1.5}
        />
      );
    default: {
      // kind === 'tag': either a directory pseudo-node (ring, colored by the
      // clustered directory) or a literal tag (small dotted circle).
      if (isDirectoryNode(node)) {
        return <circle r={r - 1} fill={hex} fillOpacity={0.12} stroke={hex} strokeWidth={2} />;
      }
      if (isPlainTagNode(node)) {
        return (
          <circle
            r={r - 0.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            className="text-neutral-400 dark:text-neutral-500"
          />
        );
      }
      return <circle r={r} fill={hex} fillOpacity={0.9} />;
    }
  }
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

const TOOLTIP_WIDTH = 240;
const TOOLTIP_EST_HEIGHT = 160;
const TOOLTIP_OFFSET = 14;

function GraphTooltip({
  node,
  x,
  y,
  containerRef,
  edges,
  nodesById,
}: {
  node: MemoryGraphNode;
  x: number;
  y: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  edges: MemoryGraphEdge[];
  nodesById: Map<string, MemoryGraphNode>;
}) {
  const containerRect = containerRef.current?.getBoundingClientRect();
  const containerWidth = containerRect?.width ?? 760;
  const containerHeight = containerRect?.height ?? 460;

  const flipX = x + TOOLTIP_OFFSET + TOOLTIP_WIDTH > containerWidth;
  const flipY = y + TOOLTIP_OFFSET + TOOLTIP_EST_HEIGHT > containerHeight;
  const left = Math.max(4, flipX ? x - TOOLTIP_OFFSET - TOOLTIP_WIDTH : x + TOOLTIP_OFFSET);
  const top = Math.max(4, flipY ? y - TOOLTIP_OFFSET - TOOLTIP_EST_HEIGHT : y + TOOLTIP_OFFSET);

  return (
    <div
      className="pointer-events-none absolute z-20 rounded-md border border-neutral-200 bg-white p-2.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left, top, width: TOOLTIP_WIDTH }}
    >
      <TooltipBody node={node} edges={edges} nodesById={nodesById} />
    </div>
  );
}

function TooltipBody({
  node,
  edges,
  nodesById,
}: {
  node: MemoryGraphNode;
  edges: MemoryGraphEdge[];
  nodesById: Map<string, MemoryGraphNode>;
}) {
  switch (node.kind) {
    case 'concept': {
      const { out, in: inCount } = linkCounts(node.id, edges);
      return (
        <div className="space-y-1">
          <div className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100">
            {nodeLabel(node)}
          </div>
          {node.path && (
            <div className="truncate font-mono text-2xs text-neutral-500 dark:text-neutral-400">{node.path}</div>
          )}
          {node.type && (
            <span className="inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {node.type}
            </span>
          )}
          <div className="text-2xs text-neutral-500 dark:text-neutral-400">
            → {out} out · ← {inCount} in
          </div>
        </div>
      );
    }
    case 'phantom': {
      const inCount = linkCounts(node.id, edges).in;
      return (
        <div className="space-y-1">
          <div className="truncate font-mono text-xs font-semibold text-neutral-900 dark:text-neutral-100">
            {node.path || node.id}
          </div>
          <div className="text-2xs text-neutral-500 dark:text-neutral-400">
            Broken link — referenced by {inCount} {inCount === 1 ? 'file' : 'files'} but doesn't exist yet
          </div>
        </div>
      );
    }
    case 'session': {
      const memberCount = edges.filter((e) => e.kind === 'session' && e.from === node.id).length;
      return (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{nodeLabel(node)}</div>
          <div className="text-2xs text-neutral-500 dark:text-neutral-400">
            Conversation session — {memberCount} {memberCount === 1 ? 'memory' : 'memories'} written together
          </div>
        </div>
      );
    }
    case 'resource': {
      const memberCount = edges.filter((e) => e.kind === 'resource' && e.to === node.id).length;
      return (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{nodeLabel(node)}</div>
          <div className="text-2xs text-neutral-500 dark:text-neutral-400">
            {memberCount} {memberCount === 1 ? 'memory' : 'memories'} about this resource
          </div>
        </div>
      );
    }
    default: {
      // kind === 'tag'
      if (isDirectoryNode(node)) {
        const fileCount = containmentFileCount(node.id, edges, nodesById, 'out');
        return (
          <div className="space-y-1">
            <div className="truncate font-mono text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              {nodeLabel(node)}
            </div>
            <div className="text-2xs text-neutral-500 dark:text-neutral-400">
              Directory — {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </div>
          </div>
        );
      }
      const fileCount = containmentFileCount(node.id, edges, nodesById, 'in');
      return (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{nodeLabel(node)}</div>
          <div className="text-2xs text-neutral-500 dark:text-neutral-400">
            Tag — {fileCount} tagged {fileCount === 1 ? 'file' : 'files'}
          </div>
        </div>
      );
    }
  }
}

// ─── Legend ─────────────────────────────────────────────────────────────────

function GraphLegend() {
  const items: Array<{ label: string; glyph: React.ReactNode }> = [
    { label: 'Concept', glyph: <circle cx={7} cy={7} r={4.5} fill="#0ea5e9" fillOpacity={0.9} /> },
    { label: 'Phantom', glyph: <circle cx={7} cy={7} r={4} fill="none" stroke="#0ea5e9" strokeWidth={1.5} strokeDasharray="2 2" /> },
    { label: 'Session', glyph: <rect x={3} y={3} width={8} height={8} fill={SESSION_HEX} fillOpacity={0.15} stroke={SESSION_HEX} strokeWidth={1.25} transform="rotate(45 7 7)" /> },
    { label: 'Resource', glyph: <rect x={3} y={3} width={8} height={8} rx={1.5} fill={RESOURCE_HEX} fillOpacity={0.15} stroke={RESOURCE_HEX} strokeWidth={1.25} /> },
    { label: 'Directory', glyph: <circle cx={7} cy={7} r={5.5} fill="#0ea5e9" fillOpacity={0.12} stroke="#0ea5e9" strokeWidth={1.5} /> },
    { label: 'Tag', glyph: <circle cx={7} cy={7} r={3.5} fill="none" stroke="#a3a3a3" strokeWidth={1.25} strokeDasharray="1.5 1.5" /> },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1 text-2xs text-neutral-500 dark:text-neutral-400">
          <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0">
            {item.glyph}
          </svg>
          {item.label}
        </div>
      ))}
    </div>
  );
}
