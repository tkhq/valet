import { DEFAULT_STEP_MODEL_CALLS, MAX_STEP_MODEL_CALLS, approvalRequestWarning, unboundedWorkWarning, type SessionNode, type ThreadNode } from "@valet/workflow";
import { NumberField } from "../fields";

/** The agent step's model call limit, with a warning when its prompt asks one agent to handle a whole list or to get a person's approval. */
export function StepBudgetField({
  node,
  onChange,
}: {
  node: SessionNode | ThreadNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const warnings = [unboundedWorkWarning(node), approvalRequestWarning(node)].filter((warning) => warning !== undefined);
  return (
    <div className="flex flex-col gap-1">
      <NumberField
        label="Model call limit"
        value={node.maxModelCalls}
        onChange={(value) => onChange({ maxModelCalls: value })}
        min={1}
        max={MAX_STEP_MODEL_CALLS}
        step={1}
      />
      <span className="text-xs text-muted">
        Default {DEFAULT_STEP_MODEL_CALLS}. At the limit, the step stops and fails with the reason.
      </span>
      {warnings.map((warning) => (
        <p key={warning} role="status" className="rounded border border-line bg-warning-wash px-3 py-2 text-xs text-ink">
          {warning}
        </p>
      ))}
    </div>
  );
}
