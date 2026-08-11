import type { ToolNode } from "@valet/workflow";
import { JsonTextarea, LabeledInput } from "../fields";

export function ToolForm({ node, onChange }: { node: ToolNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput label="Service" value={node.service} onChange={(value) => onChange({ service: value })} />
      <LabeledInput label="Action" value={node.action} onChange={(value) => onChange({ action: value })} />
      <JsonTextarea
        label="Params (JSON)"
        value={node.params}
        onChange={(value) => onChange({ params: value && typeof value === "object" ? value : {} })}
      />
      <LabeledInput label="Summary" value={node.summary ?? ""} onChange={(value) => onChange({ summary: value || undefined })} />
    </div>
  );
}
