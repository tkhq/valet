import type { WorkflowCallNode } from "@valet/workflow";
import { JsonTextarea, LabeledInput } from "../fields";

export function WorkflowCallForm({
  node,
  onChange,
}: {
  node: WorkflowCallNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput
        label="Workflow id"
        value={node.workflowId}
        onChange={(value) => onChange({ workflowId: value })}
      />
      <JsonTextarea
        label="Input (JSON, template-rendered)"
        value={node.input ?? {}}
        onChange={(value) => onChange({ input: value && typeof value === "object" ? value : undefined })}
      />
    </div>
  );
}
