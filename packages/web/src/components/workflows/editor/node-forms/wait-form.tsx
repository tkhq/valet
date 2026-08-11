import type { WaitNode } from "@valet/workflow";
import { LabeledInput } from "../fields";

export function WaitForm({ node, onChange }: { node: WaitNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <LabeledInput
      label="Duration (e.g. 5m, 1h, 30s)"
      value={node.duration}
      onChange={(value) => onChange({ duration: value })}
    />
  );
}
