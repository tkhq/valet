/**
 * Run dialog (trigger-schema form): when a workflow's trigger declares a
 * `dataSchema`, the Run button opens this dialog instead of starting the
 * run directly. One field per schema entry, mapped by declared type:
 * string → text input (or a select when `enum` is set), number → number
 * input, boolean → checkbox, object/array → JSON textarea. Defaults are
 * pre-filled; `resolveTriggerInput` (the same validator the api runs
 * server-side) gates submit so a run that would 400 never leaves the
 * dialog. Mirrors `new-workflow-dialog.tsx`'s controlled Dialog pattern.
 */
import { useId, useState } from "react";
import { normalizeInputType, resolveTriggerInput, type WorkflowInputDefinition } from "@valet/workflow";
import { Button, Dialog, DialogContent, DialogFooter, Label } from "~/components/primitives";
import { useRetryRun, useStartRun } from "~/api/workflows";
import { JsonTextarea, LabeledInput, NumberField, SelectField } from "./editor/fields";

/** Initial form state: declared defaults, everything else absent. */
function initialValues(schema: Record<string, WorkflowInputDefinition>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [field, def] of Object.entries(schema)) {
    if (def.default !== undefined) values[field] = def.default;
  }
  return values;
}

export function RunWorkflowDialog({
  workflowId,
  workflowName,
  schema,
  open,
  onOpenChange,
  onStarted,
  retryOf,
}: {
  workflowId: string;
  workflowName: string;
  schema: Record<string, WorkflowInputDefinition>;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onStarted: (runId: string) => void;
  /** Retry this run from the start. The form starts from the run's input. */
  retryOf?: { runId: string; input: Record<string, unknown> };
}) {
  const startRun = useStartRun(workflowId);
  const retryRun = useRetryRun(retryOf?.runId ?? "");
  const pending = retryOf ? retryRun.isPending : startRun.isPending;
  const [values, setValues] = useState<Record<string, unknown>>(() => retryOf ? { ...retryOf.input } : initialValues(schema));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function setValue(field: string, value: unknown) {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
  }

  async function submit() {
    const resolved = resolveTriggerInput(schema, values);
    if (resolved.errors.length > 0) {
      setFieldErrors(Object.fromEntries(resolved.errors.map((e) => [e.field, e.message])));
      return;
    }
    setFieldErrors({});
    setSubmitError(null);
    try {
      const result = retryOf
        ? await retryRun.mutateAsync({ from: "start", input: resolved.input })
        : await startRun.mutateAsync(resolved.input);
      onOpenChange(false);
      onStarted(result.runId);
    } catch (err) {
      // The dialog stays open so the user can correct the input and retry.
      setSubmitError(err instanceof Error ? err.message : "Failed to start the run.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={retryOf ? `Retry ${workflowName} from the start` : `Run ${workflowName}`}
        description={retryOf
          ? "Every step runs again with these inputs. To test a fix quickly, use a smaller input, for example a shorter date range."
          : "This workflow's trigger declares inputs. Fill them in to start the run."}
      >
        <div className="grid gap-3">
          {Object.entries(schema).map(([field, def]) => (
            <SchemaField
              key={field}
              field={field}
              def={def}
              value={values[field]}
              error={fieldErrors[field]}
              onChange={(v) => setValue(field, v)}
            />
          ))}
        </div>

        {submitError && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {submitError}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? "Starting…" : retryOf ? "Retry" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchemaField({
  field,
  def,
  value,
  error,
  onChange,
}: {
  field: string;
  def: WorkflowInputDefinition;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  // `label` first, field name only as a fallback. Every template declares
  // one, and showing the raw schema key instead ("rosterOwner") asks a
  // person to read code. `templateInputs` (the install dialog's source)
  // has always fallen back this way; this dialog did not.
  const text = def.label ?? field;
  const label = def.required ? `${text} *` : text;
  return (
    <div className="flex flex-col gap-1">
      <SchemaFieldControl label={label} def={def} value={value} onChange={onChange} />
      {def.description && <span className="text-xs text-muted">{def.description}</span>}
      {error && (
        <span role="alert" className="text-xs text-danger-600 dark:text-danger-500">
          {error}
        </span>
      )}
    </div>
  );
}

function BooleanField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[--moss] rounded border-line"
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function SchemaFieldControl({
  label,
  def,
  value,
  onChange,
}: {
  label: string;
  def: WorkflowInputDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  // `integer` is an alias for `number` — normalize before branching so an
  // integer field renders a number input, not the raw-JSON fallback.
  const type = normalizeInputType(def.type);
  switch (type) {
    case "string": {
      if (def.enum && def.enum.length > 0) {
        const options = def.enum
          .filter((v): v is string => typeof v === "string")
          .map((v) => ({ value: v, label: v }));
        return (
          <SelectField
            label={label}
            value={typeof value === "string" ? value : ""}
            onChange={(v) => onChange(v)}
            options={options}
          />
        );
      }
      return (
        <LabeledInput
          label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v === "" ? undefined : v)}
        />
      );
    }
    case "number":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "boolean":
      return <BooleanField label={label} checked={value === true} onChange={onChange} />;
    case "object":
    case "array":
      return (
        <JsonTextarea
          label={label}
          value={value}
          onChange={onChange}
          placeholder={type === "array" ? "[]" : "{}"}
        />
      );
  }
  // The schema is unknown JSON at runtime — an unrecognized type falls back
  // to raw JSON editing instead of rendering nothing.
  return <JsonTextarea label={label} value={value} onChange={onChange} />;
}
