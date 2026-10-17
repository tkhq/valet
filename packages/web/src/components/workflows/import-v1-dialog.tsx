/**
 * Import workflows from V1, the legacy stack.
 *
 * The person pastes what V1's `GET /api/workflows` and `GET /api/triggers`
 * returned. `convertV1Workflows` in `@valet/workflow` maps every step V1
 * actually ran and turns the rest into a checklist. The dialog shows each
 * workflow with its checklist before anything is created, the same review
 * step the file import uses.
 *
 * On confirm it calls the existing routes only: create the workflow, then
 * send the checklist as the first message of the workflow's editor
 * conversation, so the editor assistant finishes the items that need a
 * decision. It creates no schedules: each V1 schedule is a checklist line
 * for the person to add in Triggers.
 *
 * If a call fails after a workflow exists, the review stays on screen with
 * the error. A workflow whose editor conversation did not get its checklist
 * has no other copy of it.
 */
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  convertV1Workflows,
  readV1Paste,
  v1ChecklistPrompt,
  type V1Conversion,
  type WorkflowDefinition,
} from "@valet/workflow";
import { api } from "~/api/client";
import { useCreateWorkflow } from "~/api/workflows";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Label, Spinner, Textarea } from "~/components/primitives";
import { errorMessages } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { NODE_META } from "./editor-model";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "confirm"; value: V1Conversion }
  /** `review` is set when the import created a workflow before the error. */
  | { kind: "error"; messages: string[]; review?: V1Conversion };

export function ImportV1Dialog({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const navigate = useNavigate();
  const createWorkflow = useCreateWorkflow();
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
    // A created workflow whose checklist has not reached its editor yet.
    let unsent: string | undefined;
    let firstId: string | undefined;
    try {
      for (const wf of value.workflows) {
        const { id } = await createWorkflow.mutateAsync({ name: wf.name, definition: wf.definition, ...team });
        created.push(`the workflow "${wf.name}"`);
        firstId ??= id;
        if (wf.checklist.length > 0) {
          unsent = wf.name;
          const conversation = await api.ensureWorkflowConversation(id);
          await api.sendPrompt(conversation.sessionId, { text: v1ChecklistPrompt(wf), threadId: conversation.threadId });
          unsent = undefined;
        }
      }
    } catch (err) {
      if (created.length === 0) {
        setPhase({ kind: "error", messages: errorMessages(err) });
        return;
      }
      const lost =
        unsent === undefined
          ? []
          : [`The editor conversation of "${unsent}" did not get its checklist. Copy its checklist from the list above, and finish the items in that workflow.`];
      setPhase({
        kind: "error",
        review: value,
        messages: [
          ...errorMessages(err),
          `Valet created ${created.join(", ")} before this error. Remove those from the pasted JSON, then import again.`,
          ...lost,
        ],
      });
      return;
    }
    close();
    // The converter returns at least one workflow, so the import created one.
    if (firstId !== undefined) void navigate({ to: "/workflows/$workflowId", params: { workflowId: firstId } });
  }

  function close(): void {
    setPhase({ kind: "idle" });
    setText("");
    onOpenChange(false);
  }

  const busy = phase.kind === "busy";
  const count = phase.kind === "confirm" ? phase.value.workflows.length : 0;
  const reviewed = phase.kind === "confirm" ? phase.value : phase.kind === "error" ? phase.review : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!busy) next ? onOpenChange(true) : close();
    }}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="Import from V1"
        description="Converts V1 workflows. Anything that needs your decision, such as each V1 schedule, goes to each workflow's editor assistant."
      >
        {reviewed !== undefined ? (
          <V1Review value={reviewed} />
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
              Open /api/workflows on V1 and paste the response. To list its schedules and webhooks in
              the checklists, also paste the response of /api/triggers below it.
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
                {`Import ${count} workflow${count === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : reviewed !== undefined ? (
            // No import button: the workflows above may exist already.
            <>
              <Button variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
                Back
              </Button>
              <Button onClick={close}>Close</Button>
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

/** Each converted workflow with what it still needs, then the notes. */
function V1Review({ value }: { value: V1Conversion }) {
  return (
    <div className="grid gap-4">
      <ul className="divide-y divide-line">
        {/* A static list: index keys are safe, and V1 names need not be unique. */}
        {value.workflows.map((wf, i) => {
          const steps = stepSummary(wf.definition);
          return (
            <li key={i} aria-label={wf.name} className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <p className="min-w-0 break-words text-sm font-medium text-ink">{wf.name}</p>
                {wf.checklist.length > 0
                  ? <Badge variant="warning" className="shrink-0">{wf.checklist.length} to finish</Badge>
                  : <Badge variant="success" className="shrink-0">Ready</Badge>}
              </div>
              <p className="text-xs text-muted">{steps || "No steps"}</p>
              {wf.checklist.length > 0 && (
                <div className="mt-1 grid gap-1">
                  <p className="text-xs font-medium text-ink">The editor assistant will ask you about</p>
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
                    {wf.checklist.map((line, j) => <li key={j}>{line}</li>)}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {value.notes.length > 0 && (
        <div className="grid gap-1 border-t border-line pt-3">
          <p className="text-xs font-medium text-ink">Copy these items. No workflow checklist holds them.</p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
            {value.notes.map((note, i) => (
              <li key={i} className="break-words">{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "2 Runtime, 1 Approval": the steps a person added, in the editor's own
 * labels. The trigger and stop every workflow has are left out. */
function stepSummary(definition: WorkflowDefinition): string {
  const counts = new Map<string, number>();
  for (const node of definition.nodes) {
    if (node.type === "trigger" || node.type === "stop") continue;
    const label = NODE_META[node.type].label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(", ");
}
