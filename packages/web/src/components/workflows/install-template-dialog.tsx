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
 * required), not as a raw trigger schema. A value typed here is BAKED: the
 * server writes it into the definition and drops the field from the trigger
 * schema, so the installed workflow never asks for it again. That is what a
 * scheduled template needs, because a scheduled run applies no schema
 * defaults and has no form to ask. For a manual template it is a choice,
 * and the note above the fields says so — an empty field stays on the run
 * form.
 *
 * The dialog also opens for a template the caller cannot install, because
 * the steps and the limits live nowhere else. Install is refused here, with
 * the services to connect and who can connect them.
 *
 * `required` here means "required TO INSTALL", which only a scheduled
 * template has. Its runs arrive on a timer with no form to answer, so a
 * missing value has nowhere to come from and the server refuses the install
 * (`resolveInstallValues`). A template that runs when a person starts it
 * collects the same fields on the run form instead, so demanding them now
 * would only stop somebody installing a template to look at it and edit it.
 * That is the normal way to meet a template, so nothing is demanded here.
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
import {
  isInstallable,
  missingNote,
  missingServices,
  unconfiguredNote,
  unconfiguredServices,
} from "./template-requirements";

/** Declared defaults, and nothing else. */
function initialValues(inputs: WorkflowTemplateInput[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of inputs) {
    if (input.default !== undefined) values[input.name] = input.default;
  }
  return values;
}

/**
 * True while a required field this install cannot do without is still
 * empty. A boolean is never empty — `false` is an answer.
 *
 * `scheduled` is the whole rule, and it mirrors the server's:
 * `resolveInstallValues` refuses a missing required field for a SCHEDULED
 * template only, because a scheduled run applies no schema defaults and has
 * no form to ask. A manual template bakes what the installer supplied and
 * leaves the rest on the run form.
 *
 * Gating every required field on every template was the bug this replaces.
 * It forced the installer to answer per-RUN fields — a pull request number,
 * a brief, a spec — and install then baked each answer into the definition
 * and dropped it from `dataSchema`. The installed workflow had no run form
 * left, so it repeated the one pull request, or the one brief, forever.
 */
function hasEmptyRequired(
  inputs: WorkflowTemplateInput[],
  values: Record<string, unknown>,
  scheduled: boolean,
): boolean {
  if (!scheduled) return false;
  return inputs.some((input) => {
    if (!input.required || input.type === "boolean") return false;
    const value = values[input.name];
    if (typeof value === "number") return Number.isNaN(value);
    return typeof value !== "string" || value.trim().length === 0;
  });
}

/**
 * How the values in this dialog reach a run, in one sentence the reader
 * meets BEFORE they type. Install writes every value it is given into the
 * definition itself, so a field answered here is answered once and for all.
 */
function inputNote(scheduled: boolean): string {
  return scheduled
    ? "This workflow runs on a schedule. A scheduled run has no form to ask, so every required field has to be set now."
    : "A field you fill in is written into the workflow. A field you leave empty is asked for each time you start the workflow.";
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
  // `null`, not `undefined`: the wire always carries the field and uses
  // null for "arms no schedule" (`WorkflowTemplateSummary`).
  const scheduled = template.schedule !== null;
  const missing = missingServices(template.requires);
  const unconfigured = unconfiguredServices(template.requires);
  // The gallery opens this dialog for a card it cannot install, so the
  // reader can read the steps and the limits before they decide to connect
  // a service. Install is refused here rather than on the card, and the
  // refusal names what to do about it.
  const installable = isInstallable(template.requires);

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
            {/* Above the fields, because it changes what the reader types
                into them. Install writes a value into the definition and
                the run form stops asking for that field, so "leave it
                empty" is a real choice and not an oversight. */}
            <p className="text-xs leading-relaxed text-muted">{inputNote(scheduled)}</p>
            {template.inputs.map((input) => (
              <TemplateField
                key={input.name}
                id={`${fieldId}-${input.name}`}
                input={input}
                scheduled={template.schedule !== null}
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

        {/* The reason Install is refused, in the same place a failed
            install reports its own reason. Each line names the corrective
            action and who can take it. */}
        {!installable && (
          <div className="grid gap-1 rounded border border-line bg-ink-wash px-3 py-2">
            <p className="text-xs font-medium text-ink">You cannot install this yet</p>
            {missing.length > 0 && (
              <p className="text-xs leading-relaxed text-muted">{missingNote(missing)}</p>
            )}
            {unconfigured.length > 0 && (
              <p className="text-xs leading-relaxed text-muted">{unconfiguredNote(unconfigured)}</p>
            )}
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
            disabled={
              install.isPending ||
              !installable ||
              hasEmptyRequired(template.inputs, values, scheduled)
            }
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
  scheduled,
}: {
  id: string;
  input: WorkflowTemplateInput;
  value: unknown;
  onChange: (next: unknown) => void;
  scheduled: boolean;
}) {
  // The asterisk marks a field the install itself cannot proceed without,
  // so it follows the same rule as the button. On an unscheduled template
  // every field is answered later, on the run form.
  const label = input.required && scheduled ? `${input.label} *` : input.label;

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
