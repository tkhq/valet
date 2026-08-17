import type { SetNode } from "@valet/workflow";
import { Button } from "~/components/primitives";
import { LabeledInput } from "../fields";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `values` is `unknown` on the wire — here it's edited as a flat key/value template row list. */
export function SetForm({ node, onChange }: { node: SetNode; onChange: (patch: Record<string, unknown>) => void }) {
  const values = asRecord(node.values);
  const entries = Object.entries(values);

  function commit(next: Record<string, unknown>) {
    onChange({ values: next });
  }

  function updateEntry(index: number, key: string, value: string) {
    const next = Object.fromEntries(entries.map(([k, v], i) => (i === index ? [key, value] : [k, v])));
    commit(next);
  }

  function removeEntry(index: number) {
    const next = Object.fromEntries(entries.filter((_, i) => i !== index));
    commit(next);
  }

  function addEntry() {
    commit({ ...values, "": "" });
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Values</span>
      {entries.length === 0 && <p className="text-xs text-muted">No values configured.</p>}
      {entries.map(([key, value], index) => (
        <div key={index} className="flex items-start gap-1">
          <LabeledInput label="Key" value={key} onChange={(next) => updateEntry(index, next, String(value ?? ""))} />
          <LabeledInput
            label="Value (template)"
            value={String(value ?? "")}
            onChange={(next) => updateEntry(index, key, next)}
          />
          <Button variant="ghost" size="sm" className="mt-5" onClick={() => removeEntry(index)}>
            &times;
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={addEntry}>
        Add value
      </Button>
    </div>
  );
}
