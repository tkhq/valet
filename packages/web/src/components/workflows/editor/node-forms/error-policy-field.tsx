import type { NodeErrorPolicy } from "@valet/workflow";
import { SelectField } from "../fields";

/**
 * `onError` is not offered inside a foreach body: a body has no outgoing
 * edges, so the validator rejects it and points at `foreach.onItemError`
 * instead. Every form that renders both at top level and as a body takes
 * `allowOnError` and passes `false` from the body dispatch.
 */
export interface ErrorPolicyProps {
  allowOnError?: boolean;
}

export function ErrorPolicyField({
  value,
  onChange,
}: {
  value: NodeErrorPolicy | undefined;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <SelectField
      label="On error"
      value={value ?? "fail"}
      onChange={(next) => onChange({ onError: next })}
      options={[
        { value: "fail", label: "Fail the run" },
        { value: "continue", label: "Continue — keep running downstream nodes" },
      ]}
    />
  );
}
