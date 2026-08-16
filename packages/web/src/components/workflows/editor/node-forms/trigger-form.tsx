import type { TriggerNode, WorkflowInputDefinition } from "@valet/workflow";
import { Button } from "~/components/primitives";
import { JsonTextarea, LabeledInput, NumberField, SelectField } from "../fields";

const INPUT_TYPES: WorkflowInputDefinition["type"][] = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
];

/**
 * Edits the trigger's `dataSchema` — the declared run inputs that drive
 * the run dialog's generated form (`run-workflow-dialog.tsx`) and the
 * api's start-time validation. The node itself still can't be removed or
 * rewired; only its input declarations are editable.
 */
export function TriggerForm({
  node,
  onChange,
}: {
  node: TriggerNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const schema = node.dataSchema ?? {};
  const entries = Object.entries(schema);

  function commit(next: Array<[string, WorkflowInputDefinition]>) {
    onChange({ dataSchema: Object.fromEntries(next) });
  }

  function renameField(index: number, name: string) {
    commit(entries.map(([k, def], i) => (i === index ? [name, def] : [k, def])));
  }

  function patchField(index: number, patch: Partial<WorkflowInputDefinition>) {
    commit(entries.map(([k, def], i) => (i === index ? [k, { ...def, ...patch }] : [k, def])));
  }

  function removeField(index: number) {
    commit(entries.filter((_, i) => i !== index));
  }

  function addField() {
    let name = "input";
    for (let n = 2; Object.prototype.hasOwnProperty.call(schema, name); n++) name = `input${n}`;
    commit([...entries, [name, { type: "string" }]]);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        The trigger is where the workflow starts. Declared inputs become a form when a run starts;
        defaults pre-fill it, and required inputs must be provided.
      </p>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Inputs</span>
      {entries.length === 0 && <p className="text-xs text-muted">No inputs declared.</p>}
      {entries.map(([field, def], index) => (
        <TriggerInputRow
          key={index}
          field={field}
          def={def}
          onRename={(name) => renameField(index, name)}
          onPatch={(patch) => patchField(index, patch)}
          onRemove={() => removeField(index)}
        />
      ))}
      <Button variant="secondary" size="sm" onClick={addField}>
        Add input
      </Button>
    </div>
  );
}

function TriggerInputRow({
  field,
  def,
  onRename,
  onPatch,
  onRemove,
}: {
  field: string;
  def: WorkflowInputDefinition;
  onRename: (name: string) => void;
  onPatch: (patch: Partial<WorkflowInputDefinition>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-2">
      <LabeledInput label="Name" value={field} onChange={onRename} />
      <SelectField
        label="Type"
        value={def.type}
        onChange={(value) =>
          // Safe narrowing: `value` always comes from `INPUT_TYPES`, the
          // exhaustive type list this select's `options` were built from.
          // A type change resets default/enum — they're typed to the OLD type.
          onPatch({
            type: value as WorkflowInputDefinition["type"],
            default: undefined,
            enum: undefined,
          })
        }
        options={INPUT_TYPES.map((type) => ({ value: type, label: type }))}
      />
      <TriggerDefaultField def={def} onPatch={onPatch} />
      {def.type === "string" && (
        <LabeledInput
          label="Allowed values (comma-separated)"
          value={(def.enum ?? []).filter((v): v is string => typeof v === "string").join(", ")}
          onChange={(value) => {
            const parsed = value
              .split(",")
              .map((v) => v.trim())
              .filter((v) => v.length > 0);
            onPatch({ enum: parsed.length > 0 ? parsed : undefined });
          }}
        />
      )}
      <LabeledInput
        label="Description"
        value={def.description ?? ""}
        onChange={(value) => onPatch({ description: value || undefined })}
      />
      <label className="flex items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={def.required === true}
          onChange={(e) => onPatch({ required: e.target.checked || undefined })}
          className="h-3.5 w-3.5 accent-[--moss]"
        />
        Required
      </label>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${field}`}>
        Remove input
      </Button>
    </div>
  );
}

/** Default-value control typed to the declared input type. Clearing the
 * control removes the default entirely (`undefined`, not `""`/`null`). */
function TriggerDefaultField({
  def,
  onPatch,
}: {
  def: WorkflowInputDefinition;
  onPatch: (patch: Partial<WorkflowInputDefinition>) => void;
}) {
  switch (def.type) {
    case "string":
      return (
        <LabeledInput
          label="Default"
          value={typeof def.default === "string" ? def.default : ""}
          onChange={(value) => onPatch({ default: value || undefined })}
        />
      );
    case "number":
      return (
        <NumberField
          label="Default"
          value={typeof def.default === "number" ? def.default : undefined}
          onChange={(value) => onPatch({ default: value })}
        />
      );
    case "boolean":
      return (
        <SelectField
          label="Default"
          value={def.default === true ? "true" : def.default === false ? "false" : ""}
          onChange={(value) => onPatch({ default: value === "" ? undefined : value === "true" })}
          options={[
            { value: "", label: "No default" },
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
        />
      );
    case "object":
    case "array":
      return (
        <JsonTextarea
          label="Default"
          value={def.default}
          onChange={(value) => onPatch({ default: value })}
          placeholder={def.type === "array" ? "[]" : "{}"}
        />
      );
  }
}
