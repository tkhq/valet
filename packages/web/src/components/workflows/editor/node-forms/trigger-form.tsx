import type { TriggerNode } from "@valet/workflow";

export function TriggerForm({ node }: { node: TriggerNode }) {
  return (
    <p className="text-sm text-muted">
      The trigger is where the workflow starts. It receives the run's input data and cannot be
      removed or reconfigured here.
      {node.dataSchema && Object.keys(node.dataSchema).length > 0 && (
        <span className="mt-2 block text-xs">
          Declared inputs: {Object.keys(node.dataSchema).join(", ")}
        </span>
      )}
    </p>
  );
}
