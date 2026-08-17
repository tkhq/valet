import type { ApprovalNode } from "@valet/workflow";
import { JsonTextarea, LabeledInput, LabeledTextarea, SelectField } from "../fields";

export function ApprovalForm({
  node,
  onChange,
}: {
  node: ApprovalNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <LabeledInput label="Summary" value={node.summary ?? ""} onChange={(value) => onChange({ summary: value || undefined })} />
      <JsonTextarea label="Details (JSON)" value={node.details} onChange={(value) => onChange({ details: value })} />
      <LabeledInput
        label="Timeout (e.g. 1h, 1d)"
        value={node.timeout ?? ""}
        onChange={(value) => onChange({ timeout: value || undefined })}
      />
      <SelectField
        label="On deny"
        value={node.onDeny ?? "fail"}
        onChange={(value) => onChange({ onDeny: value })}
        options={[
          { value: "fail", label: "Fail the run" },
          { value: "skip", label: "Skip downstream" },
        ]}
      />
    </div>
  );
}
