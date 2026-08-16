import type { OrchestratorNode } from "@valet/workflow";
import { JsonTextarea, LabeledTextarea, SelectField } from "../fields";

export function OrchestratorForm({
  node,
  onChange,
}: {
  node: OrchestratorNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "none"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
    </div>
  );
}
