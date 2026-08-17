/**
 * Install dialog for one workflow template.
 *
 * The card sells the outcome; this dialog shows the mechanism before the
 * user commits — the steps in order, the cadence it arms, the limits it
 * carries, and the fields it needs. Install publishes a normal workflow and
 * lands the user on it, so the first thing they see after installing is the
 * thing they installed, not a list they have to search.
 *
 * The fields come from the server as resolved `inputs` (label, placeholder,
 * required), not as a raw trigger schema: a scheduled run applies no schema
 * defaults, so these values are written into the definition at install
 * rather than read from the trigger at run time.
 *
 * A failed install keeps the dialog open with the server's message. The
 * install is one transaction server-side, so a failure leaves nothing
 * behind, and retrying after a correction is safe.
 */
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorkflowTemplateInput, WorkflowTemplateSummary } from "@valet/api/wire";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { displayName } from "~/components/integrations/display-name";
import { apiErrorMessage } from "~/api/policies";
import { useInstallTemplate } from "~/api/templates";
import { describeCadence } from "./cadence";

/** Declared defaults, and nothing else. */
function initialValues(inputs: WorkflowTemplateInput[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of inputs) {
    if (input.default !== undefined) values[input.name] = input.default;
  }
  return values;
}

/** True while a required field is still empty. A boolean is never empty —
 * `false` is an answer. */
function hasEmptyRequired(
  inputs: WorkflowTemplateInput[],
  values: Record<string, unknown>,
): boolean {
  return inputs.some((input) => {
    if (!input.required || input.type === "boolean") return false;
    const value = values[input.name];
    if (typeof value === "number") return Number.isNaN(value);
    return typeof value !== "string" || value.trim().length === 0;
  });
}

export function InstallTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: WorkflowTemplateSummary;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const install = useInstallTemplate();
  const fieldId = useId();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(template.inputs),
  );
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const installed = await install.mutateAsync({
        templateId: template.id,
        body: template.inputs.length > 0 ? { inputs: values } : {},
      });
      onOpenChange(false);
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: installed.workflowId },
      });
    } catch (err) {
      // The dialog stays open so the user can correct a field and retry.
      setError(apiErrorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title={template.name}
        description={template.description}
      >
        {template.requires.length > 0 && (
          <div className="flex items-center gap-2">
            {template.requires.map((req) => (
              <span key={req.service} className="flex items-center gap-1.5">
                <ServiceIcon slug={req.service} label={displayName(req.service)} size="sm" />
                <span className="text-xs text-muted">{displayName(req.service)}</span>
              </span>
            ))}
          </div>
        )}

        <ol className="grid gap-2">
          {template.steps.map((step, index) => (
            <li key={index} className="flex items-start gap-2.5 text-xs leading-relaxed text-ink">
              <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ink-wash font-mono text-[10px] text-muted">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>

        <p className="font-mono text-xs text-muted">{describeCadence(template.schedule)}</p>

        {template.caveats.length > 0 && (
          <div className="rounded border border-line bg-ink-wash px-3 py-2">
            <p className="text-xs font-medium text-ink">Before you install</p>
            <ul className="mt-1 grid gap-1">
              {template.caveats.map((caveat, index) => (
                <li key={index} className="text-xs leading-relaxed text-muted">
                  {caveat}
                </li>
              ))}
            </ul>
          </div>
        )}

        {template.inputs.length > 0 && (
          <div className="grid gap-3 border-t border-line pt-4">
            {template.inputs.map((input) => (
              <TemplateField
                key={input.name}
                id={`${fieldId}-${input.name}`}
                input={input}
                value={values[input.name]}
                onChange={(next) =>
                  setValues((prev) => {
                    const updated = { ...prev };
                    if (next === undefined) delete updated[input.name];
                    else updated[input.name] = next;
                    return updated;
                  })
                }
              />
            ))}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600"
          >
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={install.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={install.isPending || hasEmptyRequired(template.inputs, values)}
          >
            {install.isPending ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateField({
  id,
  input,
  value,
  onChange,
}: {
  id: string;
  input: WorkflowTemplateInput;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const label = input.required ? `${input.label} *` : input.label;

  if (input.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-line accent-[--moss]"
        />
        <Label htmlFor={id}>{label}</Label>
        {input.description && <span className="text-xs text-muted">{input.description}</span>}
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={input.type === "number" ? "number" : "text"}
        placeholder={input.placeholder}
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (input.type === "number") {
            onChange(raw === "" ? undefined : Number(raw));
            return;
          }
          onChange(raw === "" ? undefined : raw);
        }}
      />
      {input.description && <span className="text-xs text-muted">{input.description}</span>}
    </div>
  );
}
