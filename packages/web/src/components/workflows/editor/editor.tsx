/**
 * Editor composition (plan decision 10 / Task 10): owns the
 * `WorkflowDefinition` state and wires the palette, canvas, inspector, and
 * validation banner (Tasks 8-10) together. Task 11's route mounts this
 * with `initialDefinition` loaded from `GET /workflows/:id` and `onSave`
 * bound to `useUpdateWorkflow`.
 *
 * Save semantics (plan decision 10, locked): the Save button is disabled
 * when the definition is invalid OR unchanged since the last save/load —
 * `PUT /workflows/:id` 400s on an invalid definition
 * (`packages/api/src/routes/workflows.ts`), so blocking Save on validation
 * errors here just surfaces that constraint before the round-trip instead
 * of after it. The banner (not Save) is what shows the errors themselves;
 * an invalid definition is otherwise a completely normal in-progress
 * editing state and is never silently discarded.
 */
import { useMemo, useState } from "react";
import { validateWorkflowDefinition, type WorkflowDefinition } from "@valet/workflow";
import { Button, Label, Textarea } from "~/components/primitives";
import {
  connect,
  createEdgeId,
  duplicateNode,
  removeNode as removeNodeFromDefinition,
  setNodePosition,
  setViewport,
  toFlow,
  updateEdge,
  updateNode,
  addNode as addNodeToDefinition,
  type AddableDagNodeType,
  type ConnectParams,
  type EdgeMatch,
  type EdgePatch,
  type FlowPosition,
  type FlowViewport,
  type WorkflowFlowEdge,
} from "../editor-model";
import { Canvas } from "./canvas";
import { EdgeInspector } from "./edge-inspector";
import { Inspector } from "./inspector";
import { Palette } from "./palette";
import { errorNodeIdsFrom, ValidationBanner } from "./validation-banner";

export interface EditorProps {
  initialDefinition: WorkflowDefinition;
  onSave: (definition: WorkflowDefinition) => Promise<void>;
  saving?: boolean;
}

export function Editor({ initialDefinition, onSave, saving }: EditorProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(initialDefinition);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);

  const flow = useMemo(() => toFlow(definition), [definition]);
  const validation = useMemo(() => validateWorkflowDefinition(definition), [definition]);
  const errors = validation.ok ? [] : validation.errors;
  const errorNodeIds = useMemo(() => errorNodeIdsFrom(errors), [errors]);

  const selectedNode = selectedNodeId ? definition.nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? flow.edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  const selectedEdgeSourceType = selectedEdge
    ? definition.nodes.find((n) => n.id === selectedEdge.source)?.type
    : undefined;

  function mutate(next: WorkflowDefinition) {
    setDefinition(next);
    setDirty(true);
  }

  function handleAddNode(type: AddableDagNodeType) {
    const result = addNodeToDefinition(definition, type);
    mutate(result.definition);
    setSelectedEdgeId(null);
    setSelectedNodeId(result.nodeId);
  }

  function handleNodePositionChange(nodeId: string, position: FlowPosition) {
    mutate(setNodePosition(definition, nodeId, position));
  }

  function handleConnect(params: ConnectParams) {
    const result = connect(definition, params);
    if (result.ok) mutate(result.definition);
  }

  function handleSelectNode(nodeId: string | null) {
    setSelectedNodeId(nodeId);
    if (nodeId) setSelectedEdgeId(null);
  }

  function handleSelectEdge(edgeId: string | null) {
    setSelectedEdgeId(edgeId);
    if (edgeId) setSelectedNodeId(null);
  }

  function handleViewportChange(viewport: FlowViewport) {
    setDefinition((current) => setViewport(current, viewport));
  }

  function handleRemoveNode(nodeId: string) {
    mutate(removeNodeFromDefinition(definition, nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }

  function handleRemoveEdge(edgeId: string) {
    mutate({
      ...definition,
      edges: definition.edges.filter((edge) => createEdgeId(edge.from, edge.to, edge.fromOutput) !== edgeId),
    });
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  }

  function handleDuplicateNode(nodeId: string) {
    const result = duplicateNode(definition, nodeId);
    if (!result) return;
    mutate(result.definition);
    setSelectedNodeId(result.nodeId);
  }

  function handleNodeChange(nodeId: string, patch: Record<string, unknown>) {
    mutate(updateNode(definition, nodeId, patch));
  }

  function handleEdgeChange(edge: WorkflowFlowEdge, patch: EdgePatch) {
    const match: EdgeMatch = { from: edge.source, to: edge.target, fromOutput: edge.data.fromOutput };
    mutate(updateEdge(definition, match, patch));
  }

  async function handleSave() {
    await onSave(definition);
    setDirty(false);
  }

  function handleApplyJson(next: WorkflowDefinition) {
    mutate(next);
  }

  const saveDisabled = !dirty || !validation.ok || saving === true;

  return (
    <div className="flex h-full flex-col" data-testid="workflow-editor">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          {dirty && (
            <span
              data-testid="unsaved-indicator"
              title="Unsaved changes"
              className="inline-block h-2 w-2 rounded-full bg-amber"
            />
          )}
          <Button variant={jsonMode ? "secondary" : "ghost"} size="sm" onClick={() => setJsonMode((v) => !v)}>
            {jsonMode ? "Visual editor" : "Edit JSON"}
          </Button>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saveDisabled}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <ValidationBanner errors={errors} />

      {jsonMode ? (
        <div className="flex-1 overflow-y-auto p-3">
          <JsonDefinitionEditor definition={definition} onApply={handleApplyJson} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Palette onAdd={handleAddNode} />
          <div className="min-w-0 flex-1">
            <Canvas
              flow={flow}
              errorNodeIds={errorNodeIds}
              onNodePositionChange={handleNodePositionChange}
              onConnect={handleConnect}
              onSelectNode={handleSelectNode}
              onSelectEdge={handleSelectEdge}
              onViewportChange={handleViewportChange}
              onRemoveNode={handleRemoveNode}
              onRemoveEdge={handleRemoveEdge}
            />
          </div>
          <div className="w-80 shrink-0 border-l border-line">
            {selectedNode ? (
              <Inspector
                key={selectedNode.id}
                node={selectedNode}
                onChange={(patch) => handleNodeChange(selectedNode.id, patch)}
                onRemove={() => handleRemoveNode(selectedNode.id)}
                onDuplicate={() => handleDuplicateNode(selectedNode.id)}
              />
            ) : selectedEdge && selectedEdgeSourceType ? (
              <EdgeInspector
                key={selectedEdge.id}
                edge={selectedEdge}
                sourceNodeType={selectedEdgeSourceType}
                onChange={(patch) => handleEdgeChange(selectedEdge, patch)}
                onRemove={() => handleRemoveEdge(selectedEdge.id)}
              />
            ) : (
              <p className="p-3 text-sm text-muted">Select a node or edge to edit its settings.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Type guard for the "Edit JSON" toggle's Apply step — narrows `unknown` to `WorkflowDefinition`
 * without an `as` cast; anything that fails this shape check stays a parse error, never a save. */
function isWorkflowDefinitionShape(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "string" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

/**
 * Deliberately not `JsonTextarea` (`fields.tsx`): that component
 * auto-propagates on every valid keystroke, which here would mean typing
 * a definition edit re-derives the whole flow/inspector state mid-edit.
 * The JSON-mode round-trip is edit-then-explicit-"Apply" instead —
 * `text` is local until the button is pressed.
 */
function JsonDefinitionEditor({
  definition,
  onApply,
}: {
  definition: WorkflowDefinition;
  onApply: (definition: WorkflowDefinition) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(definition, null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleApply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid JSON");
      return;
    }
    if (!isWorkflowDefinitionShape(parsed)) {
      setError('definition must be an object with "version", "nodes", and "edges"');
      return;
    }
    setError(null);
    onApply(parsed);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="workflow-json-editor">Definition (JSON)</Label>
      <Textarea
        id="workflow-json-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={24}
        className="font-mono text-xs"
        aria-invalid={error !== null}
      />
      {error && (
        <span role="alert" className="text-xs text-danger-600 dark:text-danger-500">
          {error}
        </span>
      )}
      <Button size="sm" onClick={handleApply}>
        Apply
      </Button>
    </div>
  );
}
