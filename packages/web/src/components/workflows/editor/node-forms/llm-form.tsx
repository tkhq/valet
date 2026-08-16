import type { LlmNode } from "@valet/workflow";
import { JsonTextarea, LabeledInput, LabeledTextarea, NumberField } from "../fields";
import { ErrorPolicyField, type ErrorPolicyProps } from "./error-policy-field";

export function LlmForm({
  node,
  onChange,
  allowOnError = true,
}: { node: LlmNode; onChange: (patch: Record<string, unknown>) => void } & ErrorPolicyProps) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput label="Model" value={node.model} onChange={(value) => onChange({ model: value })} />
      <LabeledTextarea label="System" value={node.system ?? ""} onChange={(value) => onChange({ system: value || undefined })} />
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <NumberField
        label="Temperature"
        value={node.temperature}
        onChange={(value) => onChange({ temperature: value })}
        min={0}
        max={2}
        step={0.1}
      />
      <NumberField
        label="Max output tokens"
        value={node.maxOutputTokens}
        onChange={(value) => onChange({ maxOutputTokens: value })}
        min={1}
      />
      {allowOnError && <ErrorPolicyField value={node.onError} onChange={onChange} />}
    </div>
  );
}
