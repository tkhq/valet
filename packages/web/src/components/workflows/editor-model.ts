/**
 * Pure editor model for the visual workflow editor.
 *
 * Lifted from main's `packages/client/src/components/workflows/workflow-editor-model.ts`
 * (1503 lines) and trimmed hard per the node-completion-plan decision 9:
 *
 *   KEPT: definition<->flow conversion (with fromOutput-labeled source
 *   handles on if/approval sources), add/remove/duplicate/update node,
 *   connect rules (single trigger root, no self-edges, fromOutput only
 *   from if/approval), position persistence into `definition.ui`, viewport
 *   persistence, dirty tracking, unique id generation, BFS-depth layered
 *   auto-layout.
 *
 *   DROPPED (out of scope for the v2 node set / this task): NODE_DOCS
 *   (replaced by a small local `NODE_META` table — v2 has no docs
 *   package), the tool-catalog/data-flow-source machinery
 *   (`deriveWorkflowOutputSources`, `buildWorkflowEdgeInspection`,
 *   `applyDefaultDataFlowForConnection`, JSON-schema<->input-definition
 *   conversion, the node palette filter/search helpers) — none of that is
 *   part of decision 9's deliverable list, and main's edge/node CSS
 *   styling (colors, stroke widths, edge `type`) which belongs to the
 *   presentation layer (Tasks 9-10), not the pure model. Legacy node
 *   types and `session.workspace`/prompt-mode are gone because the v2
 *   `SessionNode` (see `@valet/workflow`'s `dag/nodes.ts`) trims to
 *   start-mode only.
 *
 * This module has no React dependency — Tasks 9-10 build the xyflow
 * presentation on top of it.
 */

import {
  validateWorkflowDefinition,
  type ApprovalNode,
  type DagNodeType,
  type ForeachNode,
  type IfNode,
  type LlmNode,
  type OrchestratorNode,
  type SessionNode,
  type SetNode,
  type StopNode,
  type ToolNode,
  type TriggerNode,
  type WaitNode,
  type WorkflowCallNode,
  type WorkflowDefinition,
  type WorkflowEditorState,
  type WorkflowEdge,
  type WorkflowNode,
} from '@valet/workflow';

export { validateWorkflowDefinition };
export type { WorkflowDefinition, WorkflowNode, WorkflowEdge, DagNodeType };

/**
 * Structural narrowing from the wire's `unknown` definition (both
 * `WorkflowDefinitionSummary.definition` and the editor's JSON-mode
 * "Apply" step) to `WorkflowDefinition`, without an `as` cast. Anything
 * failing this check stays a load/parse error, never a silent bad save —
 * shared by `editor.tsx`'s JSON toggle and `workflows.$workflowId.tsx`'s
 * initial-load guard. Lives here (the pure, React-free model module)
 * rather than a standalone form-helpers file since both consumers already
 * import from `editor-model`.
 */
export function isWorkflowDefinitionShape(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

// ─── Flow types (xyflow-shaped, but xyflow-independent) ──────────────────────

export interface FlowPosition {
  x: number;
  y: number;
}

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkflowFlowNodeData {
  [key: string]: unknown;
  node: WorkflowNode;
  nodeType: DagNodeType;
  label: string;
  description: string;
  summary: string;
  sourceOutputs?: Array<'true' | 'false'>;
}

export interface WorkflowFlowNode {
  id: string;
  type: 'workflow';
  position: FlowPosition;
  deletable?: boolean;
  data: WorkflowFlowNodeData;
}

export interface WorkflowFlowEdge {
  id: string;
  source: string;
  sourceHandle?: 'true' | 'false';
  target: string;
  data: {
    fromOutput?: 'true' | 'false';
    when?: string;
  };
}

export interface WorkflowFlowState {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  viewport?: FlowViewport;
}

// ─── Node metadata (replaces main's NODE_DOCS for the v2 node set) ───────────

export type AddableDagNodeType = Exclude<DagNodeType, 'trigger'>;

export interface NodeMeta {
  label: string;
  description: string;
  defaultNode: (id: string) => WorkflowNode;
}

export const NODE_META: Record<DagNodeType, NodeMeta> = {
  trigger: {
    label: 'Trigger',
    description: 'Where the workflow starts and what data it receives',
    defaultNode: (id): TriggerNode => ({ id, type: 'trigger' }),
  },
  set: {
    label: 'Set values',
    description: 'Create values for downstream nodes',
    defaultNode: (id): SetNode => ({ id, type: 'set', values: {} }),
  },
  if: {
    label: 'If',
    description: 'Branch based on conditions',
    defaultNode: (id): IfNode => ({ id, type: 'if', conditions: [] }),
  },
  wait: {
    label: 'Wait',
    description: 'Pause for a fixed duration',
    defaultNode: (id): WaitNode => ({ id, type: 'wait', mode: 'duration', duration: '5m' }),
  },
  approval: {
    label: 'Approval',
    description: 'Pause for human approval',
    defaultNode: (id): ApprovalNode => ({ id, type: 'approval', prompt: '' }),
  },
  session: {
    label: 'Session',
    description: 'Start a coding session',
    defaultNode: (id): SessionNode => ({ id, type: 'session', mode: 'start', prompt: '' }),
  },
  stop: {
    label: 'Stop',
    description: 'Finish the workflow',
    defaultNode: (id): StopNode => ({ id, type: 'stop', outcome: 'success' }),
  },
  foreach: {
    label: 'For each',
    description: 'Run one body node for every item',
    defaultNode: (id): ForeachNode => ({
      id,
      type: 'foreach',
      items: '',
      body: { id: `${id}-body`, type: 'set', values: {} },
    }),
  },
  llm: {
    label: 'LLM',
    description: 'Generate or transform text with a model',
    defaultNode: (id): LlmNode => ({ id, type: 'llm', model: '', prompt: '' }),
  },
  orchestrator: {
    label: 'Orchestrator',
    description: 'Ask the user orchestrator to do work',
    defaultNode: (id): OrchestratorNode => ({ id, type: 'orchestrator', prompt: '' }),
  },
  tool: {
    label: 'Tool',
    description: 'Call an integration action',
    defaultNode: (id): ToolNode => ({ id, type: 'tool', service: '', action: '', params: {} }),
  },
  workflow: {
    label: 'Workflow',
    description: 'Run another workflow and wait for its result',
    defaultNode: (id): WorkflowCallNode => ({ id, type: 'workflow', workflowId: '' }),
  },
};

export const ADDABLE_NODE_TYPES: AddableDagNodeType[] = [
  'llm',
  'tool',
  'if',
  'foreach',
  'approval',
  'wait',
  'set',
  'orchestrator',
  'session',
  'workflow',
  'stop',
];

// ─── id generation ────────────────────────────────────────────────────────────

export function createNodeId(type: DagNodeType, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let index = 1;
  let candidate = `${type}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${type}-${index}`;
  }
  return candidate;
}

// ─── definition <-> flow conversion ───────────────────────────────────────────

export function toFlow(definition: WorkflowDefinition): WorkflowFlowState {
  const savedPositions = definition.ui?.nodes;
  const fallbackPositions = autoLayout(definition);

  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: 'workflow',
      position: savedPositions?.[node.id]?.position ?? fallbackPositions[node.id] ?? { x: 0, y: 0 },
      ...(node.type === 'trigger' ? { deletable: false } : {}),
      data: createFlowNodeData(node),
    })),
    edges: definition.edges.map(workflowEdgeToFlowEdge),
    viewport: definition.ui?.viewport,
  };
}

export function fromFlow(
  flow: WorkflowFlowState,
  previous?: Pick<WorkflowDefinition, 'policy'>,
): WorkflowDefinition {
  const ui: WorkflowEditorState = {
    nodes: Object.fromEntries(flow.nodes.map((node) => [node.id, { position: node.position }])),
    ...(flow.viewport ? { viewport: flow.viewport } : {}),
  };

  return {
    version: 'dag/v1',
    nodes: flow.nodes.map((node) => node.data.node),
    edges: flow.edges.map(flowEdgeToWorkflowEdge),
    ...(previous?.policy ? { policy: previous.policy } : {}),
    ui,
  };
}

function createFlowNodeData(node: WorkflowNode): WorkflowFlowNodeData {
  return {
    node,
    nodeType: node.type,
    label: NODE_META[node.type].label,
    description: NODE_META[node.type].description,
    summary: summarizeNode(node),
    ...(node.type === 'if' || node.type === 'approval'
      ? { sourceOutputs: ['true', 'false'] as Array<'true' | 'false'> }
      : {}),
  };
}

export function createEdgeId(from: string, to: string, fromOutput?: 'true' | 'false'): string {
  return `${from}${fromOutput ? `:${fromOutput}` : ''}->${to}`;
}

export function workflowEdgeToFlowEdge(edge: WorkflowEdge): WorkflowFlowEdge {
  return {
    id: createEdgeId(edge.from, edge.to, edge.fromOutput),
    source: edge.from,
    ...(edge.fromOutput ? { sourceHandle: edge.fromOutput } : {}),
    target: edge.to,
    data: {
      ...(edge.fromOutput ? { fromOutput: edge.fromOutput } : {}),
      ...(edge.when ? { when: edge.when } : {}),
    },
  };
}

export function flowEdgeToWorkflowEdge(edge: WorkflowFlowEdge): WorkflowEdge {
  const fromOutput = edge.data.fromOutput ?? edge.sourceHandle;
  return {
    from: edge.source,
    to: edge.target,
    ...(fromOutput ? { fromOutput } : {}),
    ...(edge.data.when ? { when: edge.data.when } : {}),
  };
}

// ─── connect ──────────────────────────────────────────────────────────────────

export interface ConnectParams {
  source: string;
  target: string;
  sourceHandle?: 'true' | 'false';
}

export type ConnectResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; error: string };

/**
 * Applies the connect rules: source/target must exist, no self-edges, the
 * trigger node (single root) cannot have incoming edges, and `fromOutput`
 * (true/false source handles) is only valid leaving an `if` or `approval`
 * node — mirrors `validateWorkflowDefinition`'s edge checks in
 * `@valet/workflow` so a connection the editor allows never fails
 * validation for these reasons.
 */
export function connect(definition: WorkflowDefinition, params: ConnectParams): ConnectResult {
  const { source, target, sourceHandle } = params;
  const sourceNode = definition.nodes.find((node) => node.id === source);
  const targetNode = definition.nodes.find((node) => node.id === target);

  if (!sourceNode) return { ok: false, error: `unknown source node "${source}"` };
  if (!targetNode) return { ok: false, error: `unknown target node "${target}"` };
  if (source === target) return { ok: false, error: 'cannot connect a node to itself' };
  if (targetNode.type === 'trigger') {
    return { ok: false, error: 'the trigger node cannot have incoming edges' };
  }
  if (sourceHandle !== undefined && sourceNode.type !== 'if' && sourceNode.type !== 'approval') {
    return {
      ok: false,
      error: `fromOutput handles are only valid on "if" or "approval" sources, not "${sourceNode.type}"`,
    };
  }

  const alreadyExists = definition.edges.some(
    (edge) => edge.from === source && edge.to === target && edge.fromOutput === sourceHandle,
  );
  if (alreadyExists) return { ok: true, definition };

  const edge: WorkflowEdge = { from: source, to: target, ...(sourceHandle ? { fromOutput: sourceHandle } : {}) };
  return { ok: true, definition: { ...definition, edges: [...definition.edges, edge] } };
}

// ─── add / remove / duplicate / update node ──────────────────────────────────

export interface AddNodeResult {
  definition: WorkflowDefinition;
  nodeId: string;
}

export function addNode(
  definition: WorkflowDefinition,
  type: AddableDagNodeType,
  options: { position?: FlowPosition } = {},
): AddNodeResult {
  const id = createNodeId(type, definition.nodes.map((node) => node.id));
  const node = NODE_META[type].defaultNode(id);
  const position = options.position ?? nextFreePosition(definition);

  return {
    nodeId: id,
    definition: {
      ...definition,
      nodes: [...definition.nodes, node],
      ui: {
        ...definition.ui,
        nodes: { ...(definition.ui?.nodes ?? {}), [id]: { position } },
      },
    },
  };
}

function nextFreePosition(definition: WorkflowDefinition): FlowPosition {
  const positions = definition.ui?.nodes;
  const xs = positions ? Object.values(positions).map((entry) => entry.position.x) : [];
  if (xs.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...xs) + LAYOUT_COLUMN_GAP, y: 0 };
}

/** Removing the trigger node is a no-op — it's the single required root. */
export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === 'trigger') return definition;

  const uiNodes = { ...(definition.ui?.nodes ?? {}) };
  delete uiNodes[nodeId];

  return {
    ...definition,
    nodes: definition.nodes.filter((n) => n.id !== nodeId),
    edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    ui: { ...definition.ui, nodes: uiNodes },
  };
}

/** Duplicating the trigger node is disallowed — it returns null. */
export function duplicateNode(definition: WorkflowDefinition, nodeId: string): AddNodeResult | null {
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === 'trigger') return null;

  const id = createNodeId(node.type, definition.nodes.map((n) => n.id));
  // A foreach's nested body carries its own id, which must stay unique
  // across ALL foreach bodies (validator rule) — a shallow clone would
  // alias the original's body id. Re-key it off the new foreach id, the
  // same `{id}-body` convention NODE_META's default factory uses.
  const clone =
    node.type === 'foreach' ? { ...node, id, body: { ...node.body, id: `${id}-body` } } : { ...node, id };
  const sourcePosition = definition.ui?.nodes?.[nodeId]?.position ?? { x: 0, y: 0 };
  const position = { x: sourcePosition.x + 40, y: sourcePosition.y + 40 };

  return {
    nodeId: id,
    definition: {
      ...definition,
      nodes: [...definition.nodes, clone],
      ui: {
        ...definition.ui,
        nodes: { ...(definition.ui?.nodes ?? {}), [id]: { position } },
      },
    },
  };
}

/**
 * `patch` is untyped (`Record<string, unknown>`) rather than
 * `Partial<WorkflowNode>` on purpose: `Partial` of a discriminated union
 * collapses to the fields common to every member (`id`/`type`), which
 * would make this unusable for e.g. patching an llm node's `prompt`.
 * Callers (the Task 10 inspector forms) already know which node type
 * they're editing; `id` and `type` are pinned from the existing node so a
 * patch can never smuggle a type change through.
 */
export function updateNode(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Record<string, unknown>,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => (node.id === nodeId ? mergeNodePatch(node, patch) : node)),
  };
}

function mergeNodePatch(node: WorkflowNode, patch: Record<string, unknown>): WorkflowNode {
  // See the `updateNode` doc comment for why this cast is the sanctioned
  // exception: `id`/`type` are pinned from `node` immediately before the
  // cast, so the discriminant can't drift from what `node.type` already
  // guarantees.
  return { ...node, ...patch, id: node.id, type: node.type } as WorkflowNode;
}

// ─── edges ────────────────────────────────────────────────────────────────────

export interface EdgeMatch {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
}

export interface EdgePatch {
  when?: string;
  fromOutput?: 'true' | 'false';
}

export function updateEdge(
  definition: WorkflowDefinition,
  match: EdgeMatch,
  patch: EdgePatch,
): WorkflowDefinition {
  return {
    ...definition,
    edges: definition.edges.map((edge) => (edgeMatches(edge, match) ? applyEdgePatch(edge, patch) : edge)),
  };
}

function edgeMatches(edge: WorkflowEdge, match: EdgeMatch): boolean {
  return edge.from === match.from && edge.to === match.to && edge.fromOutput === match.fromOutput;
}

function applyEdgePatch(edge: WorkflowEdge, patch: EdgePatch): WorkflowEdge {
  const nextFromOutput = 'fromOutput' in patch ? patch.fromOutput : edge.fromOutput;
  const nextWhen = 'when' in patch ? patch.when : edge.when;
  return {
    from: edge.from,
    to: edge.to,
    ...(nextFromOutput ? { fromOutput: nextFromOutput } : {}),
    ...(nextWhen ? { when: nextWhen } : {}),
  };
}

// ─── position / viewport persistence ─────────────────────────────────────────

export function setNodePosition(
  definition: WorkflowDefinition,
  nodeId: string,
  position: FlowPosition,
): WorkflowDefinition {
  if (!definition.nodes.some((node) => node.id === nodeId)) return definition;
  return {
    ...definition,
    ui: {
      ...definition.ui,
      nodes: {
        ...(definition.ui?.nodes ?? {}),
        [nodeId]: { ...(definition.ui?.nodes?.[nodeId] ?? {}), position },
      },
    },
  };
}

/** Batch form of `setNodePosition` for e.g. drag-end over multiple selected nodes. */
export function applyPositions(
  definition: WorkflowDefinition,
  positions: Record<string, FlowPosition>,
): WorkflowDefinition {
  const knownIds = new Set(definition.nodes.map((node) => node.id));
  const nextNodes = { ...(definition.ui?.nodes ?? {}) };
  for (const [nodeId, position] of Object.entries(positions)) {
    if (!knownIds.has(nodeId)) continue;
    nextNodes[nodeId] = { ...(nextNodes[nodeId] ?? {}), position };
  }
  return { ...definition, ui: { ...definition.ui, nodes: nextNodes } };
}

export function setViewport(definition: WorkflowDefinition, viewport: FlowViewport): WorkflowDefinition {
  return { ...definition, ui: { nodes: definition.ui?.nodes ?? {}, viewport } };
}

// ─── auto-layout (BFS depth layering, no dagre/elk) ──────────────────────────

export const LAYOUT_COLUMN_GAP = 260;
export const LAYOUT_ROW_GAP = 120;

/**
 * Column = BFS depth from the roots (nodes with no incoming edges — in
 * practice just the trigger); row = index within that depth, in
 * `definition.nodes` order. Deterministic: the same definition always
 * produces the same positions. Nodes unreachable from any root (dangling
 * edges, or genuinely disconnected) fall back to their index in
 * `definition.nodes` as their depth, so they still get a placed, distinct
 * position instead of colliding at the origin.
 */
export function autoLayout(definition: WorkflowDefinition): Record<string, FlowPosition> {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const depths = computeBfsDepths(definition.nodes, incoming, outgoing);

  const nodesByDepth = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const depth = depths.get(node.id) ?? 0;
    nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node.id]);
  }

  const positions: Record<string, FlowPosition> = {};
  for (const [depth, ids] of nodesByDepth) {
    ids.forEach((id, row) => {
      positions[id] = { x: depth * LAYOUT_COLUMN_GAP, y: row * LAYOUT_ROW_GAP };
    });
  }
  return positions;
}

function computeBfsDepths(
  nodes: WorkflowNode[],
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const remainingIncoming = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue: string[] = nodes.filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const id of queue) depths.set(id, 0);

  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const nextDepth = (depths.get(id) ?? 0) + 1;
    for (const target of outgoing.get(id) ?? []) {
      depths.set(target, Math.max(depths.get(target) ?? 0, nextDepth));
      const remaining = (remainingIncoming.get(target) ?? 0) - 1;
      remainingIncoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  // Nodes never reached (cycles, or every predecessor is itself
  // unreached) still need a deterministic depth: fall back to their
  // position in `definition.nodes`.
  for (const [index, node] of nodes.entries()) {
    if (!depths.has(node.id)) depths.set(node.id, index);
  }

  return depths;
}

/** Overwrites every node's saved position with the auto-layout result; keeps the viewport. */
export function applyAutoLayout(definition: WorkflowDefinition): WorkflowDefinition {
  const positions = autoLayout(definition);
  return {
    ...definition,
    ui: {
      ...definition.ui,
      nodes: Object.fromEntries(definition.nodes.map((node) => [node.id, { position: positions[node.id] ?? { x: 0, y: 0 } }])),
    },
  };
}

// ─── node summaries ────────────────────────────────────────────────────────────

function summarizeNode(node: WorkflowNode): string {
  switch (node.type) {
    case 'trigger':
      return 'Where the workflow starts and what data it receives';
    case 'set': {
      const count = Object.keys(asRecord(node.values)).length;
      return `${count} value${count === 1 ? '' : 's'}`;
    }
    case 'if': {
      // Defensive `?? 0`: definitions saved before the validator required
      // `conditions` may carry an `if` node without the array — a summary
      // must degrade, not crash the whole canvas.
      const count = node.conditions?.length ?? 0;
      return `${count} condition${count === 1 ? '' : 's'}`;
    }
    case 'wait':
      return node.duration || 'No duration configured';
    case 'approval':
      return trimSummary(node.summary || node.prompt || 'No prompt configured');
    case 'session':
      return trimSummary(node.prompt || 'No prompt configured');
    case 'stop':
      return trimSummary(node.message || node.outcome || 'success');
    case 'workflow':
      return node.workflowId ? `Runs ${node.workflowId}` : 'No workflow selected';
    case 'foreach':
      return trimSummary(node.items || 'No item expression configured');
    case 'llm':
      return trimSummary(node.prompt || node.model || 'No prompt configured');
    case 'orchestrator':
      return trimSummary(node.prompt || 'No prompt configured');
    case 'tool':
      return trimSummary(node.service && node.action ? `${node.service}.${node.action}` : 'No action configured');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function trimSummary(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

// ─── EditorModel: stateful wrapper with dirty tracking ───────────────────────

/**
 * Thin stateful wrapper over the pure functions above, for Tasks 9-10's
 * presentation layer: holds the current `WorkflowDefinition`, tracks
 * whether it has changed since the last `markSaved()`, and exposes the
 * same operations as mutating calls instead of definition-in/definition-out
 * functions. Every mutating method is a one-line call into a pure
 * function above — the pure functions remain independently testable and
 * are the ones exercised by most of this file's test suite.
 */
export class EditorModel {
  private definition: WorkflowDefinition;
  private dirtyFlag = false;

  constructor(definition: WorkflowDefinition) {
    this.definition = definition;
  }

  get dirty(): boolean {
    return this.dirtyFlag;
  }

  toFlow(): WorkflowFlowState {
    return toFlow(this.definition);
  }

  connect(params: ConnectParams): ConnectResult {
    const result = connect(this.definition, params);
    if (result.ok && result.definition !== this.definition) {
      this.definition = result.definition;
      this.dirtyFlag = true;
    }
    return result;
  }

  addNode(type: AddableDagNodeType, options?: { position?: FlowPosition }): string {
    const result = addNode(this.definition, type, options);
    this.definition = result.definition;
    this.dirtyFlag = true;
    return result.nodeId;
  }

  removeNode(nodeId: string): void {
    const next = removeNode(this.definition, nodeId);
    if (next !== this.definition) {
      this.definition = next;
      this.dirtyFlag = true;
    }
  }

  duplicateNode(nodeId: string): string | null {
    const result = duplicateNode(this.definition, nodeId);
    if (!result) return null;
    this.definition = result.definition;
    this.dirtyFlag = true;
    return result.nodeId;
  }

  updateNode(nodeId: string, patch: Record<string, unknown>): void {
    this.definition = updateNode(this.definition, nodeId, patch);
    this.dirtyFlag = true;
  }

  updateEdge(match: EdgeMatch, patch: EdgePatch): void {
    this.definition = updateEdge(this.definition, match, patch);
    this.dirtyFlag = true;
  }

  setNodePosition(nodeId: string, position: FlowPosition): void {
    this.definition = setNodePosition(this.definition, nodeId, position);
    this.dirtyFlag = true;
  }

  applyPositions(positions: Record<string, FlowPosition>): void {
    this.definition = applyPositions(this.definition, positions);
    this.dirtyFlag = true;
  }

  setViewport(viewport: FlowViewport): void {
    this.definition = setViewport(this.definition, viewport);
    this.dirtyFlag = true;
  }

  applyAutoLayout(): void {
    this.definition = applyAutoLayout(this.definition);
    this.dirtyFlag = true;
  }

  /** Replaces the whole definition (e.g. the "Edit JSON" toggle round-trip). Marks dirty. */
  replace(definition: WorkflowDefinition): void {
    this.definition = definition;
    this.dirtyFlag = true;
  }

  validate(): ReturnType<typeof validateWorkflowDefinition> {
    return validateWorkflowDefinition(this.definition);
  }

  serialize(): WorkflowDefinition {
    return this.definition;
  }

  markSaved(): void {
    this.dirtyFlag = false;
  }
}

// ─── minimal starter definition ───────────────────────────────────────────────

export function createDefaultWorkflowDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'stop', type: 'stop', outcome: 'success' }],
    edges: [{ from: 'trigger', to: 'stop' }],
    ui: {
      nodes: {
        trigger: { position: { x: 0, y: 0 } },
        stop: { position: { x: LAYOUT_COLUMN_GAP, y: 0 } },
      },
    },
  };
}
