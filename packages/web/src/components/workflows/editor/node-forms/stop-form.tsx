import type { StopNode } from "@valet/workflow";
import { JsonTextarea, LabeledTextarea, SelectField } from "../fields";

export function StopForm({ node, onChange }: { node: StopNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Outcome"
        value={node.outcome ?? "success"}
        onChange={(value) => onChange({ outcome: value })}
        options={[
          { value: "success", label: "Success" },
          { value: "failure", label: "Failure" },
        ]}
      />
      <LabeledTextarea label="Message" value={node.message ?? ""} onChange={(value) => onChange({ message: value || undefined })} />
      <JsonTextarea label="Output (JSON)" value={node.output} onChange={(value) => onChange({ output: value })} />
    </div>
  );
}
