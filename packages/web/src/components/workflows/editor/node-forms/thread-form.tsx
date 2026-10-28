import type { ThreadNode } from "@valet/workflow";
import { StepBudgetField } from "./step-budget-field";
import { JsonTextarea, LabeledTextarea, SelectField } from "../fields";

export function ThreadForm({
  node,
  onChange,
}: {
  node: ThreadNode;
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
      <StepBudgetField node={node} onChange={onChange} />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "until_idle"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
      <SelectField
        label="Thread"
        value={node.thread ?? "run"}
        onChange={(value) => onChange({ thread: value === "run" ? undefined : value })}
        options={[
          { value: "run", label: "Run thread: after earlier steps, with their context" },
          { value: "step", label: "Own thread: new conversation, without earlier context" },
        ]}
      />
      {node.thread === "step" && (
        <span className="text-xs text-muted">
          In a foreach, entries run in parallel only when Concurrency is above 1. With Wait mode None, the step runs beside the steps after it.
        </span>
      )}
    </div>
  );
}
