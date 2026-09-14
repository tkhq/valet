/**
 * The composed xyflow canvas surface (plan decision 10, canvas half).
 *
 * Deliberately "dumb": it owns no workflow state. The parent (`editor.tsx`)
 * owns the `WorkflowDefinition` via the editor-model's pure functions and
 * passes down its current `toFlow()` snapshot plus an `errorNodeIds` set derived
 * from `validate()`. Local xyflow node/edge arrays exist only so dragging
 * feels smooth (xyflow needs to own the array identity during a drag
 * gesture); every drag-end and connect immediately calls back up into the
 * model via the provided callbacks, and the next render's `flow` prop is
 * the new source of truth.
 *
 * NOTHING ON THIS CANVAS ANIMATES ON ITS OWN. The editor is handed a
 * definition, never a run, so it cannot know which step is in flight and
 * has no honest reason to draw motion. Direction is carried at rest by an
 * arrowhead on every edge. The dashed travelling edge belongs to the run
 * overlay (`preview.tsx`, which marks edges into a running node
 * `animated`), where there is real work to point at. The one motion here
 * answers an input: a node the canvas has not drawn before arrives instead
 * of appearing, which is how an assistant edit shows what it changed.
 *
 * Wave bands: the canvas also answers "what runs at the same time?", which
 * the arrows alone cannot. `analyzeConcurrency` (editor-model) groups the
 * nodes that become runnable together, `waveBands` turns each group into a
 * rectangle, and a `ViewportPortal` draws those rectangles behind the cards
 * in flow coordinates. Only groups of two or more get a band, so a straight
 * line of steps draws none. Per-node fan-in/fan-out counts ride along on
 * `FlowNodeData.parallel`.
 *
 * Edge labels: `flow-edge.tsx` uses an orthogonal path and a viewport-portal
 * badge. It keeps long conditions compact, preserves the full condition for
 * assistive technology, and offsets sibling labels so branch labels do not
 * share one midpoint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  Background,
  ControlButton,
  Controls,
  MarkerType,
  ReactFlow,
  useReactFlow,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMarker,
  type EdgeTypes,
  type FitViewOptions,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FlowEdge, edgeLabelOffsets, type FlowEdgeData } from "./flow-edge";
import {
  FlowNode,
  NODE_CARD_MAX_HEIGHT,
  NODE_CARD_WIDTH,
  type FlowNodeData,
  type FlowXyNode,
} from "./flow-node";
import {
  analyzeConcurrency,
  type ConcurrencyModel,
  type ConnectParams,
  type FlowPosition,
  type FlowViewport,
  type WorkflowFlowState,
} from "../editor-model";

const nodeTypes = { workflow: FlowNode };
const edgeTypes: EdgeTypes = { workflow: FlowEdge };
type CanvasEdge = Edge<FlowEdgeData, "workflow">;

/**
 * A first-open camera should use the available canvas, not preserve xyflow's
 * conservative default. The floor protects readable card and label text on
 * a complex graph. A saved viewport always takes precedence.
 */
export const INITIAL_FIT_OPTIONS: FitViewOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1.1 };
/** A manual fit must show the whole graph, even when that requires smaller text. */
export const MANUAL_FIT_OPTIONS: FitViewOptions = { padding: 0.16 };

/**
 * The arrowhead that makes a directed graph readable without tracing it.
 * Size is deliberately left out: `markerUnits` defaults to `strokeWidth`,
 * so the head keeps its proportion to the line and grows with it when an
 * edge is hovered or selected.
 */
const ARROW_END: EdgeMarker = { type: MarkerType.ArrowClosed };

export interface CanvasProps {
  readOnly?: boolean;
  flow: WorkflowFlowState;
  errorNodeIds?: ReadonlySet<string>;
  /** Per-node policy predictions (`gate` on `FlowNodeData`), keyed by node
   * id. Absent while the permissions query is loading — cards draw no gate
   * badge until it lands. */
  gateByNodeId?: ReadonlyMap<string, "require_approval" | "deny">;
  onNodePositionChange: (nodeId: string, position: FlowPosition) => void;
  onConnect: (params: ConnectParams) => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onViewportChange?: (viewport: FlowViewport) => void;
  onRemoveNode?: (nodeId: string) => void;
  onRemoveEdge?: (edgeId: string) => void;
}

/**
 * Pure change-routing so remove/position/selection semantics are testable
 * without going through xyflow's onNodesChange prop plumbing (jsdom can't
 * cleanly fire real drag/delete gestures). `setNodes` is left to the caller
 * so xyflow keeps owning array identity during a drag; this function only
 * decides which callbacks a given batch of changes should trigger.
 */
export function routeNodeChanges(
  changes: NodeChange<FlowXyNode>[],
  callbacks: {
    onNodePositionChange: (nodeId: string, position: FlowPosition) => void;
    onRemoveNode?: (nodeId: string) => void;
  },
): void {
  for (const change of changes) {
    if (change.type === "position" && change.position && change.dragging === false) {
      callbacks.onNodePositionChange(change.id, change.position);
    } else if (change.type === "remove") {
      callbacks.onRemoveNode?.(change.id);
    }
  }
}

export function routeEdgeChanges<EdgeType extends Edge>(changes: EdgeChange<EdgeType>[], callbacks: { onRemoveEdge?: (edgeId: string) => void }): void {
  for (const change of changes) {
    if (change.type === "remove") {
      callbacks.onRemoveEdge?.(change.id);
    }
  }
}

/**
 * Which nodes in `flow` were not in the previous snapshot. Pure, and
 * separate from the ref that remembers the previous ids, so the "what just
 * arrived" rule can be read and tested without a canvas.
 */
export function enteringNodeIds(
  flow: WorkflowFlowState,
  previousIds: ReadonlySet<string>,
): Set<string> {
  const entering = new Set<string>();
  for (const node of flow.nodes) {
    if (!previousIds.has(node.id)) entering.add(node.id);
  }
  return entering;
}

function toXyNodes(
  flow: WorkflowFlowState,
  errorNodeIds: ReadonlySet<string>,
  entering: ReadonlySet<string>,
  concurrency: ConcurrencyModel,
  gateByNodeId?: ReadonlyMap<string, "require_approval" | "deny">,
): FlowXyNode[] {
  return flow.nodes.map((node) => {
    const counts = concurrency.byNode[node.id];
    const gate = gateByNodeId?.get(node.id);
    return {
      id: node.id,
      type: "workflow",
      position: node.position,
      deletable: node.deletable,
      data: {
        label: node.data.label,
        summary: node.data.summary,
        nodeType: node.data.nodeType,
        hasError: errorNodeIds.has(node.id),
        sourceOutputs: node.data.sourceOutputs,
        ...(gate ? { gate } : {}),
        ...(entering.has(node.id) ? { entering: true } : {}),
        ...(counts
          ? {
              // `wave` is +1 only here, so the card and the band label say
              // the same number to the reader.
              parallel: {
                wave: counts.wave + 1,
                parallelOut: counts.parallelOut,
                exclusiveOut: counts.exclusiveOut,
                fanIn: counts.fanIn,
              },
            }
          : {}),
      } satisfies FlowNodeData,
    };
  });
}

/**
 * Room left around a group's cards, in flow units. It has to clear the moss
 * selection ring and the focus outline, both of which paint outside the
 * card's border box.
 */
const BAND_PADDING = 16;

/** One drawn band: a rectangle in flow coordinates, plus what it says. */
export interface WaveBand {
  id: string;
  /** 1-based, matching the number on every card inside the band. */
  wave: number;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle behind each group of steps that can be in flight together.
 *
 * The box is the group's own cards, padded — NOT a column of the graph.
 * Cards are dragged, so a wave is wherever the reader has put it, and a band
 * drawn from layout columns would drift off the thing it describes. Two
 * bands can therefore overlap after a drag; that is the honest picture of
 * the positions, and the reader can move a card to separate them.
 */
export function waveBands(flow: WorkflowFlowState, concurrency: ConcurrencyModel): WaveBand[] {
  const positions = new Map(flow.nodes.map((node) => [node.id, node.position]));
  const bands: WaveBand[] = [];

  for (const group of concurrency.groups) {
    const points = group.nodeIds
      .map((id) => positions.get(id))
      .filter((position): position is FlowPosition => position !== undefined);
    if (points.length < 2) continue;

    const left = Math.min(...points.map((point) => point.x));
    const right = Math.max(...points.map((point) => point.x)) + NODE_CARD_WIDTH;
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y)) + NODE_CARD_MAX_HEIGHT;

    bands.push({
      id: group.id,
      wave: group.wave + 1,
      count: points.length,
      x: left - BAND_PADDING,
      y: top - BAND_PADDING,
      width: right - left + BAND_PADDING * 2,
      height: bottom - top + BAND_PADDING * 2,
    });
  }

  return bands;
}

export function toXyEdges(
  flow: WorkflowFlowState,
  onSelect?: (edgeId: string) => void,
): CanvasEdge[] {
  const offsets = edgeLabelOffsets(flow.edges);
  return flow.edges.map((edge) => ({
    id: edge.id,
    type: "workflow",
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    data: {
      ...edge.data,
      ...(offsets.has(edge.id) ? { labelOffsetY: offsets.get(edge.id) } : {}),
      ...(onSelect ? { onSelect } : {}),
    },
    markerEnd: ARROW_END,
  }));
}

/**
 * The first movement after an unsaved canvas mounts is React Flow's automatic
 * fit. Consume only that one movement. Subsequent moves can be user actions,
 * including Controls buttons that do not provide a DOM event.
 */
export function viewportMoveResult(initialFitPending: boolean): {
  persist: boolean;
  initialFitPending: boolean;
} {
  return initialFitPending
    ? { persist: false, initialFitPending: false }
    : { persist: true, initialFitPending: false };
}

function WorkflowControls({
  readOnly,
  onUserViewportIntent,
}: {
  readOnly: boolean;
  onUserViewportIntent: () => void;
}) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  return (
    <Controls
      showZoom={false}
      showFitView={false}
      showInteractive={!readOnly}
      className="max-sm:[&>button]:min-h-11 max-sm:[&>button]:min-w-11"
    >
      <ControlButton
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => {
          onUserViewportIntent();
          void zoomIn();
        }}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </ControlButton>
      <ControlButton
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => {
          onUserViewportIntent();
          void zoomOut();
        }}
      >
        <Minus className="h-4 w-4" aria-hidden />
      </ControlButton>
      <ControlButton
        aria-label="Fit view"
        title="Fit view"
        onClick={() => {
          onUserViewportIntent();
          void fitView(MANUAL_FIT_OPTIONS);
        }}
      >
        <Maximize className="h-4 w-4" aria-hidden />
      </ControlButton>
    </Controls>
  );
}

export function Canvas({
  readOnly = false,
  flow,
  errorNodeIds,
  gateByNodeId,
  onNodePositionChange,
  onConnect,
  onSelectNode,
  onSelectEdge,
  onViewportChange,
  onRemoveNode,
  onRemoveEdge,
}: CanvasProps) {
  const errors = errorNodeIds ?? EMPTY_IDS;
  // The ids this canvas has already drawn. It stays null until the first
  // snapshot is processed, and that snapshot treats itself as already
  // drawn: opening a workflow animates nothing, and only what arrives
  // afterwards comes in. The set is rebuilt per snapshot rather than added
  // to, so a node that is removed and later restored arrives again.
  const drawnIds = useRef<ReadonlySet<string> | null>(null);
  const initialFitPending = useRef(!flow.viewport);
  const edgeSelectRef = useRef(onSelectEdge);
  edgeSelectRef.current = onSelectEdge;
  const concurrency = useMemo(() => analyzeConcurrency(flow), [flow]);
  const bands = useMemo(() => waveBands(flow, concurrency), [flow, concurrency]);
  const [nodes, setNodes] = useState<FlowXyNode[]>(() =>
    toXyNodes(flow, errors, EMPTY_IDS, concurrency, gateByNodeId),
  );
  const [edges, setEdges] = useState<CanvasEdge[]>(() =>
    toXyEdges(flow, selectEdgeFromLabel),
  );

  function selectEdgeFromLabel(edgeId: string) {
    // Labels render in a viewport portal, outside xyflow's edge group. Mirror
    // the library's selected state before informing the editor, so its moss
    // selected styling remains visible after a label click.
    setEdges((current) => current.map((edge) => ({ ...edge, selected: edge.id === edgeId })));
    edgeSelectRef.current(edgeId);
  }

  // The model is the source of truth; whenever the parent hands us a new
  // snapshot (add/remove/duplicate/connect/patch), re-derive local state
  // from it. Position changes during an in-progress drag are local-only
  // until drag-end, so this doesn't fight the user's cursor. `gateByNodeId`
  // is read from the closure here, NOT a dependency — a full rebuild on a
  // query refresh would snap back a mid-drag card and drop xyflow's
  // selection state. The patch effect below paints late-arriving gates.
  useEffect(() => {
    const drawn = new Set(flow.nodes.map((node) => node.id));
    const entering = enteringNodeIds(flow, drawnIds.current ?? drawn);
    drawnIds.current = drawn;
    setNodes(toXyNodes(flow, errors, entering, concurrency, gateByNodeId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  // The permissions query usually lands AFTER the first snapshot renders.
  // Patch `gate` in place instead of rebuilding, so positions, selection,
  // and in-flight arrival animations survive the refresh.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const gate = gateByNodeId?.get(node.id);
        if (gate === node.data.gate) return node;
        const data = { ...node.data };
        if (gate) data.gate = gate;
        else delete data.gate;
        return { ...node, data };
      }),
    );
  }, [gateByNodeId]);

  useEffect(() => {
    setEdges(toXyEdges(flow, selectEdgeFromLabel));
  }, [flow]);

  function handleNodesChange(changes: NodeChange<FlowXyNode>[]) {
    if (readOnly) changes = changes.filter((change) => change.type === "select" || change.type === "dimensions");
    setNodes((current) => applyNodeChanges(changes, current));
    routeNodeChanges(changes, { onNodePositionChange, onRemoveNode });
  }

  function handleEdgesChange(changes: EdgeChange<CanvasEdge>[]) {
    if (readOnly) changes = changes.filter((change) => change.type === "select");
    setEdges((current) => applyEdgeChanges<CanvasEdge>(changes, current));
    routeEdgeChanges(changes, { onRemoveEdge });
  }

  function handleConnect(connection: Connection) {
    if (readOnly) return;
    onConnect({
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle === "true" || connection.sourceHandle === "false" ? connection.sourceHandle : undefined,
    });
  }

  function markUserViewportIntent() {
    initialFitPending.current = false;
  }

  function handleMoveStart(event: unknown) {
    // Pointer and wheel gestures carry an event. Controls call the marker
    // directly because their viewport API calls have no DOM event.
    if (event instanceof Event) markUserViewportIntent();
  }

  function handleMoveEnd(_event: unknown, viewport: Viewport) {
    const result = viewportMoveResult(initialFitPending.current);
    initialFitPending.current = result.initialFitPending;
    if (result.persist) onViewportChange?.(viewport);
  }

  return (
    <div className="h-full w-full" data-testid="workflow-canvas">
      <ReactFlow
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : "Backspace"}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onEdgeClick={(_event, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        defaultViewport={flow.viewport}
        fitView={!flow.viewport}
        fitViewOptions={INITIAL_FIT_OPTIONS}
        minZoom={0.1}
        // Arrowheads carry an inline fill, which outranks the stylesheet,
        // so the library's hardcoded light grey would survive into dark
        // mode. Naming the token here is the only place that colour can be
        // set once for every marker on the canvas.
        defaultMarkerColor="var(--muted)"
        // The other two canvases already hide it; this one is the surface a
        // person spends real time in, so the library's badge sat on the
        // workflow they were building.
        proOptions={{ hideAttribution: true }}
      >
        {/* Wave bands. `ViewportPortal` puts them in the SAME coordinate
            frame as the cards, so they pan and zoom with the graph instead
            of sliding off it. `zIndex: -1` drops them behind the edges and
            the cards, and `pointer-events: none` keeps the pane draggable
            through them. `translate` rather than `left`/`top` because the
            portal's own div is not positioned. */}
        <ViewportPortal>
          {bands.map((band) => (
            <div
              key={band.id}
              data-testid="wave-band"
              data-wave={band.wave}
              // `border-muted`, not `border-line`: `--line` is a hairline
              // tone picked to disappear against paper, and this frame has
              // to hold in every palette and both polarities. It is the
              // same call `styles/react-flow.css` makes for the dot grid.
              // `bg-ink-wash` is the pre-mixed token — an opacity suffix on
              // a raw `oklch()` token emits no rule at all here.
              className="pointer-events-none absolute left-0 top-0 rounded-lg border border-dashed border-muted bg-ink-wash"
              style={{
                transform: `translate(${band.x}px, ${band.y}px)`,
                width: band.width,
                height: band.height,
                zIndex: -1,
              }}
            >
              {/* Sat on the band's top edge like a fieldset legend, on a
                  paper ground so the dashed line does not run through the
                  words. */}
              <span className="absolute -top-2 left-3 whitespace-nowrap rounded bg-paper px-1.5 text-[10px] font-medium text-muted">
                Wave {band.wave} · {band.count} steps ready at once
              </span>
            </div>
          ))}
        </ViewportPortal>
        <Background />
        <WorkflowControls readOnly={readOnly} onUserViewportIntent={markUserViewportIntent} />
      </ReactFlow>
    </div>
  );
}

/** Stands in for both "no node has a validation error" and "nothing is
 * arriving", which are the same empty set of node ids. */
const EMPTY_IDS: ReadonlySet<string> = new Set();
