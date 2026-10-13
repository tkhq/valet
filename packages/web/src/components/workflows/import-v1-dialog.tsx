/**
 * Import workflows from V1, the legacy stack.
 *
 * The person pastes what V1's `GET /api/workflows` and `GET /api/triggers`
 * returned. `convertV1Workflows` in `@valet/workflow` maps every step V1
 * actually ran and turns the rest into a checklist. The dialog shows each
 * workflow with its checklist before anything is created, the same review
 * step the file import uses.
 *
 * On confirm it calls the existing routes only: create the workflow, create
 * its schedules, then send the checklist as the first message of the
 * workflow's editor conversation, so the editor assistant finishes the items
 * that need a decision.
 */
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  convertV1Workflows,
  readV1Paste,
  v1ChecklistPrompt,
  type V1Conversion,
} from "@valet/workflow";
import { api } from "~/api/client";
import { useCreateSchedule, useCreateWorkflow } from "~/api/workflows";
import { Button, Dialog, DialogContent, DialogFooter, Label, Spinner, Textarea } from "~/components/primitives";
import { errorMessages } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { DefinitionSummary } from "./import-workflow-dialog";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "confirm"; value: V1Conversion }
  | { kind: "error"; messages: string[] };

export function ImportV1Dialog({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const navigate = useNavigate();
  const createWorkflow = useCreateWorkflow();
  const createSchedule = useCreateSchedule();
  const scope = useWorkspaceScope();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  function review(): void {
    const read = readV1Paste(text);
    if (!read.ok) {
      setPhase({ kind: "error", messages: [read.error] });
      return;
    }
    const converted = convertV1Workflows(read.value);
    setPhase(converted.ok ? { kind: "confirm", value: converted.value } : { kind: "error", messages: converted.errors });
  }

  async function commit(value: V1Conversion): Promise<void> {
    setPhase({ kind: "busy" });
    const team = scope.teamId === undefined ? {} : { teamId: scope.teamId };
    // What exists so far, so a failure part way says what not to import twice.
    const created: string[] = [];
    let firstId: string | undefined;
    try {
      for (const wf of value.workflows) {
        const { id } = await createWorkflow.mutateAsync({ name: wf.name, definition: wf.definition, ...team });
        created.push(`the workflow "${wf.name}"`);
        firstId ??= id;
        for (const s of wf.schedules) {
          await createSchedule.mutateAsync({ name: s.name, cron: s.cron, timezone: s.timezone, target: { kind: "workflow", workflowId: id } });
        }
        if (wf.checklist.length > 0) {
          const conversation = await api.ensureWorkflowConversation(id);
          await api.sendPrompt(conversation.sessionId, { text: v1ChecklistPrompt(wf), threadId: conversation.threadId });
        }
      }
      for (const s of value.promptSchedules) {
        await createSchedule.mutateAsync({ name: s.name, cron: s.cron, timezone: s.timezone, ...team, target: { kind: "orchestrator", prompt: s.prompt } });
        created.push(`the schedule "${s.name}"`);
      }
    } catch (err) {
      const already =
        created.length === 0
          ? []
          : [`Valet created ${created.join(", ")} before this error. Remove those from the pasted JSON, then import again.`];
      setPhase({ kind: "error", messages: [...errorMessages(err), ...already] });
      return;
    }
    close();
    if (firstId !== undefined) void navigate({ to: "/workflows/$workflowId", params: { workflowId: firstId } });
    else void navigate({ to: "/workflows", search: { tab: "scheduled" } });
  }

  function close(): void {
    setPhase({ kind: "idle" });
    setText("");
    onOpenChange(false);
  }

  const busy = phase.kind === "busy";
  const count = phase.kind === "confirm" ? phase.value.workflows.length : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="Import from V1"
        description="Converts V1 workflows and their schedules. The editor assistant of each workflow gets the items that need a decision."
      >
        {phase.kind === "confirm" ? (
          <V1Review value={phase.value} />
        ) : (
          <div className="grid gap-2">
            <Label htmlFor={`${fieldId}-text`}>V1 JSON</Label>
            <Textarea
              id={`${fieldId}-text`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={'{ "workflows": [ ... ] }\n{ "triggers": [ ... ] }'}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted">
              Open /api/workflows on V1 and paste the response. To bring schedules, also paste the
              response of /api/triggers below it.
            </p>
          </div>
        )}

        {phase.kind === "error" && (
          <ul role="alert" className="grid gap-1 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2">
            {phase.messages.map((message) => (
              <li key={message} className="text-xs leading-relaxed text-danger-600">
                {message}
              </li>
            ))}
          </ul>
        )}

        {busy && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner size={12} /> Importing…
          </p>
        )}

        <DialogFooter>
          {phase.kind === "confirm" ? (
            <>
              <Button variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
                Back
              </Button>
              <Button onClick={() => void commit(phase.value)}>
                {count === 0 ? "Import" : `Import ${count} workflow${count === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={review} disabled={busy || text.trim() === ""}>
                Review
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Each converted workflow with what it still needs, then the prompts and notes. */
function V1Review({ value }: { value: V1Conversion }) {
  return (
    <div className="grid gap-3">
      {/* A static list: index keys are safe, and V1 names need not be unique. */}
      {value.workflows.map((wf, i) => (
        <section key={i} aria-label={wf.name} className="grid gap-2 rounded border border-line px-3 py-2">
          <p className="text-sm font-medium text-ink">{wf.name}</p>
          <DefinitionSummary definition={wf.definition} />
          {wf.schedules.length > 0 && (
            <p className="text-xs text-muted">
              Schedules: {wf.schedules.map((s) => `${s.name} (${s.cron})`).join(", ")}
            </p>
          )}
          {wf.checklist.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-xs text-muted">The editor assistant gets these items to finish:</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
                {wf.checklist.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted">Every step converted. Nothing needs a decision.</p>
          )}
        </section>
      ))}

      {value.promptSchedules.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs text-muted">These schedules send a prompt to the assistant:</p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
            {value.promptSchedules.map((s, i) => (
              <li key={i}>
                {s.name} ({s.cron}): {s.prompt}
              </li>
            ))}
          </ul>
        </div>
      )}

      {value.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          {value.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
