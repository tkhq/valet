import { type Presence, validatePresence } from "@valet/shared";
import { PresenceSettings } from "~/components/presence-settings";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCreateWorkflow } from "~/api/workflows";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "~/components/primitives";
import { createDefaultWorkflowDefinition } from "./editor-model";
import { errorText } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";

const DEFAULT_NAME = "Untitled workflow";

/** How a new workflow starts. A schedule or an event opens its trigger form
 * next, so a trigger is created with the workflow it runs. */
type StartKind = "manual" | "schedule" | "event";
const START_OPTIONS: { value: StartKind; label: string; hint: string }[] = [
  { value: "manual", label: "Manually", hint: "Run it with the Run button." },
  { value: "schedule", label: "On a schedule", hint: "Set the time next." },
  { value: "event", label: "When an event happens", hint: "Pick the event next, such as a Slack message or a pull request." },
];

export function NewWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const scope = useWorkspaceScope();
  return <WorkflowCreationForm key={scope.teamId === undefined ? "personal" : `team:${scope.teamId}`}
    open={open} onOpenChange={onOpenChange} teamId={scope.teamId} />;
}

function WorkflowCreationForm({ open, onOpenChange, teamId }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  teamId: string | undefined;
}) {
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [open]);
  const [presence, setPresence] = useState<Presence>({});
  const [name, setName] = useState(DEFAULT_NAME);
  const [start, setStart] = useState<StartKind>("manual");

  async function submit() {
    const trimmed = name.trim();
    if (!open || create.isPending || !trimmed || validatePresence(presence) !== null) return;
    const requestGeneration = generation.current;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        definition: { ...createDefaultWorkflowDefinition(), ...(Object.keys(presence).length > 0 ? { presence } : {}) },
        ...(teamId === undefined ? {} : { teamId }),
      });
      // A workspace change unmounts this form. Its late response must not
      // close the new form or navigate away from the new workspace.
      if (generation.current !== requestGeneration) return;
      onOpenChange(false);
      setName(DEFAULT_NAME);
      setPresence({});
      setStart("manual");
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: created.id },
        ...(start === "manual" ? {} : { search: { newTrigger: start } }),
      });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="New workflow"
        description="Start with an empty workflow and add steps in the editor."
      >
        <div className="grid gap-1">
          <Label htmlFor="workflow-name">Name</Label>
          <Input
            id="workflow-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder={DEFAULT_NAME}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">How does it start?</legend>
          {START_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-line px-3 py-2 text-sm has-[:checked]:border-accent">
              <input
                type="radio"
                name="workflow-start"
                value={option.value}
                checked={start === option.value}
                onChange={() => setStart(option.value)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-ink">{option.label}</span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <PresenceSettings value={presence} onChange={setPresence} disabled={create.isPending} />

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {errorText(create.error)}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !name.trim() || validatePresence(presence) !== null}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
