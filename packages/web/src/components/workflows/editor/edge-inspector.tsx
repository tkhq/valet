/**
 * Edge inspector (plan decision 10): edits an edge's `when` condition
 * expression, and — only when the source node is an `if` or `approval`
 * (the only node types that render `true`/`false` source handles, per
 * `flow-node.tsx`) — which output branch the edge leaves from.
 */
import { Button } from "~/components/primitives";
import type { DagNodeType, EdgePatch, WorkflowFlowEdge } from "../editor-model";
import { LabeledInput, SelectField } from "./fields";

export interface EdgeInspectorProps {
  edge: WorkflowFlowEdge;
  sourceNodeType: DagNodeType;
  onChange: (patch: EdgePatch) => void;
  onRemove: () => void;
}

const FROM_OUTPUT_OPTIONS = [
  { value: "", label: "(either)" },
  { value: "true", label: "true" },
  { value: "false", label: "false" },
];

export function EdgeInspector({ edge, sourceNodeType, onChange, onRemove }: EdgeInspectorProps) {
  const showFromOutput = sourceNodeType === "if" || sourceNodeType === "approval";

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Edge</span>
        <div className="mt-0.5 truncate text-sm text-ink" title={`${edge.source} → ${edge.target}`}>
          {edge.source} → {edge.target}
        </div>
      </div>

      {showFromOutput && (
        <SelectField
          label="From output"
          value={edge.data.fromOutput ?? ""}
          onChange={(value) =>
            onChange({ fromOutput: value === "true" || value === "false" ? value : undefined })
          }
          options={FROM_OUTPUT_OPTIONS}
        />
      )}

      <LabeledInput
        label="When (condition expression)"
        value={edge.data.when ?? ""}
        onChange={(value) => onChange({ when: value === "" ? undefined : value })}
        placeholder='e.g. nodes.check.result.severity == "high"'
      />

      <Button variant="danger" size="sm" onClick={onRemove}>
        Remove edge
      </Button>
    </div>
  );
}
