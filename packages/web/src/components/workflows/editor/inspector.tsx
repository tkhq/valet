/**
 * Node inspector (plan decision 10): the header (remove/duplicate) plus the
 * per-type form, dispatched by `./node-forms/registry`. Every form calls
 * `onChange` with a `Record<string, unknown>` patch — the same shape
 * `updateNode` in `editor-model.ts` expects (id/type are pinned there, so a
 * form can never smuggle a type change through).
 */
import type { WorkflowNode } from "@valet/workflow";
import { Button } from "~/components/primitives";
import { NodeForm } from "./node-forms/registry";

export interface InspectorProps {
  node: WorkflowNode;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}

export function Inspector({ node, onChange, onRemove, onDuplicate }: InspectorProps) {
  return (
    <div className="flex h-full flex-col" data-testid="inspector">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">{node.type}</span>
        <div className="flex gap-1">
          {node.type !== "trigger" && (
            <Button variant="ghost" size="sm" onClick={onDuplicate}>
              Duplicate
            </Button>
          )}
          {node.type !== "trigger" && (
            <Button variant="danger" size="sm" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <NodeForm key={node.id} node={node} onChange={onChange} />
      </div>
    </div>
  );
}
