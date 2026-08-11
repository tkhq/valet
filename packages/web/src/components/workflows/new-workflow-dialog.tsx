/**
 * "New workflow" dialog (Task 11 review fix 1): prompts for a name before
 * creating a definition, instead of the hardcoded "Untitled workflow" with
 * no rename affordance. Mirrors `~/components/new-session-dialog.tsx` —
 * same controlled `open`/`onOpenChange` + `Dialog`/`DialogContent`/
 * `DialogFooter` composition, same "stays open with the mutation's error
 * on failure" pattern.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "~/components/primitives";
import { useCreateWorkflow } from "~/api/workflows";
import { useTeams } from "~/api/settings";

const DEFAULT_NAME = "Untitled workflow";

/** Owner of a new workflow: the caller, or a team the caller belongs to.
 * The value is the `teamId` the create route takes, and "" means the
 * caller. Same convention as the skill editor's owner picker. */
const OWNER_SELF = "";

/** A brand-new definition's starting shape — the minimal valid `dag/v1`
 * graph (trigger straight into stop). "New workflow" creates one of these
 * immediately and drops the user into the editor rather than an empty
 * canvas or a JSON textarea (plan decision 11). */
function blankDefinition() {
  return {
    version: "dag/v1" as const,
    nodes: [
      { id: "trigger", type: "trigger" as const },
      { id: "stop", type: "stop" as const, outcome: "success" as const },
    ],
    edges: [{ from: "trigger", to: "stop" }],
  };
}

export function NewWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const teams = useTeams();
  const [name, setName] = useState(DEFAULT_NAME);
  const [teamId, setTeamId] = useState(OWNER_SELF);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        definition: blankDefinition(),
        ...(teamId === OWNER_SELF ? {} : { teamId }),
      });
      onOpenChange(false);
      setName(DEFAULT_NAME);
      void navigate({ to: "/workflows/$workflowId", params: { workflowId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New workflow"
        description="Starts from a minimal trigger → stop graph. You can build it out in the editor."
      >
        <div className="grid gap-1">
          <Label htmlFor="workflow-name">Name</Label>
          <Input
            id="workflow-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={DEFAULT_NAME}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

        {(teams.data?.teams.length ?? 0) > 0 && (
          <div className="grid gap-1">
            <Label htmlFor="workflow-owner">Owner</Label>
            <select
              id="workflow-owner"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="h-9 w-full rounded border border-[--border] bg-[--bg] px-3 text-sm text-[--fg]"
            >
              <option value={OWNER_SELF}>You</option>
              {teams.data?.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">
              Every member of the owning team can see, edit, and run it.
            </p>
          </div>
        )}

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {create.error.message}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
