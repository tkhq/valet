/**
 * The editor's **Do** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 4): three cards, the instructions, the workflow picker with a
 * routine's run input under Advanced, the event message under Advanced with
 * `Insert a detail from the event`, and the assistant choice when the
 * workspace offers more than one.
 */
import { useId, useRef } from "react";
import { fieldLabel } from "~/components/events/filter-editor";
import { unionFilterFields, type CatalogService } from "~/components/events/subscription-match";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  Textarea,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { selectsSlackMention } from "~/lib/slack-mention";
import type { WorkflowNames } from "../sentences";
import { parseRunInput, type AssistantKind, type DoKind, type Draft, type EditorMode } from "./draft";

/** One assistant the reader may pick. */
export interface AssistantOption {
  value: AssistantKind;
  label: string;
  teamId?: string;
}

interface Card {
  kind: DoKind;
  title: string;
  line: string;
}

function cards(routine: boolean): Card[] {
  if (routine) {
    return [
      { kind: "work", title: "Work on it", line: "Valet works on your instructions in a thread, with your workspace's access." },
      { kind: "workflow", title: "Run a workflow", line: "Start a workflow at each time." },
    ];
  }
  return [
    { kind: "reply", title: "Reply", line: "Answer in the conversation the event came from. Slack only." },
    { kind: "work", title: "Work on it", line: "Valet reads the event and acts in a thread, with your workspace's access." },
    { kind: "workflow", title: "Run a workflow", line: "Start a workflow with the event as its input." },
  ];
}

/**
 * The names the event message (`userPromptTemplate`) accepts. It mirrors
 * `VARIABLE_RE` in packages/api/src/events/prompt-template.ts. The
 * instructions (`systemPrompt`) take `{{event.key}}` only, so text from the
 * event never becomes an instruction; they get no insert menu.
 */
export const EVENT_MESSAGE_VARIABLE = /^(event\.(key|summary|body)|refs\.[A-Za-z0-9_-]+|payload\.[A-Za-z0-9_-]+)$/;

/** The details the event message may name: the event's summary and body,
 * then each payload field the picked events declare. */
export function eventMessageDetails(draft: Draft, services: readonly CatalogService[]): { label: string; template: string }[] {
  const fields = unionFilterFields([...services], draft.events);
  return [
    { label: "The event's summary", template: "{{event.summary}}" },
    { label: "The event's text", template: "{{event.body}}" },
    ...fields.map((f) => ({ label: fieldLabel(f.field), template: `{{payload.${f.field}}}` })),
  ];
}

export function DoSection({
  draft,
  mode,
  onChange,
  services,
  workflows,
  assistants,
  teamName,
}: {
  draft: Draft;
  mode: EditorMode;
  onChange: (next: Draft) => void;
  services: readonly CatalogService[];
  workflows: WorkflowNames;
  /** The assistants the workspace offers. One or none hides the choice. */
  assistants: readonly AssistantOption[];
  /** The team's name, for who may mention a team assistant. */
  teamName?: string;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const routine = draft.service === "schedule";
  const stored = mode.kind !== "create";
  // The team Slack setup fixes the team's assistant.
  const fixedTeam = mode.kind === "create" && mode.preselected?.team !== undefined;
  const runInputBad = parseRunInput(draft.runInput).kind === "bad";
  const assistant = draft.doKind !== "workflow";
  const required = routine && assistant;
  // Only a mention starts a conversation to reply in (Reply stores `follow`
  // only for a mention). A Slack line without one offers Work on it.
  const mention = selectsSlackMention([...draft.events]);
  const replyNeedsMention = !stored && !routine && draft.service === "slack" && !mention;

  function pick(kind: DoKind) {
    if (kind === draft.doKind) return;
    onChange({
      ...draft,
      doKind: kind,
      workflowId: kind === "workflow" && draft.workflowId.length === 0 ? workflows[0]?.id ?? "" : draft.workflowId,
      where: null,
      whereChosen: false,
      whereTitle: undefined,
    });
  }

  function insert(template: string) {
    const el = box.current;
    const text = draft.promptTemplates.userPromptTemplate;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + template + text.slice(end);
    onChange({ ...draft, promptTemplates: { userPromptTemplate: next } });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + template.length, start + template.length);
    });
  }

  return (
    <>
      <div role="radiogroup" aria-label="Do" className="grid gap-2.5 sm:grid-cols-3">
        {cards(routine).map((card) => {
          const on = draft.doKind === card.kind;
          // A Reply already picked stays open, so the reader can see it and move off it.
          const off = stored || (card.kind === "reply" && (draft.service !== "slack" || (replyNeedsMention && !on)));
          const lineId = `${id}-line-${card.kind}`;
          return (
            <label
              key={card.kind}
              className={cn(
                "grid cursor-pointer gap-1 rounded-lg border border-line px-3.5 py-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-500",
                on && "border-ink ring-1 ring-ink",
                off && !on && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name={`${id}-do`}
                className="sr-only"
                aria-label={card.title}
                aria-describedby={lineId}
                checked={on}
                disabled={off}
                onChange={() => pick(card.kind)}
              />
              <span className="text-[15px] font-medium text-ink">{card.title}</span>
              <span id={lineId} className="text-[13px] leading-snug text-muted">{card.line}</span>
            </label>
          );
        })}
      </div>
      {replyNeedsMention && (
        <p className="text-xs text-muted">Reply answers a mention. To reply, pick the mention in When.</p>
      )}
      {stored && (
        <p className="text-xs text-muted">
          To change what Valet does, delete this {mode.kind === "edit-routine" ? "routine" : "line"} and make a new one.
        </p>
      )}

      {draft.doKind === "workflow" && (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-workflow`}>Workflow</Label>
          <select
            id={`${id}-workflow`}
            value={draft.workflowId}
            disabled={stored}
            onChange={(e) => onChange({ ...draft, workflowId: e.target.value })}
            className="min-h-11 w-full min-w-0 truncate rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
          >
            <option value="">Pick a workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {workflows.length === 0 && (
            <p className="text-xs text-muted">You have no workflows yet. Make one on the Workflows page, then come back.</p>
          )}
          {routine && (
            <details className="mt-1 text-sm" open={draft.runInput.trim().length > 0}>
              <summary className="cursor-pointer text-xs text-muted hover:text-ink">Advanced</summary>
              <div className="mt-2 grid gap-1">
                <Label htmlFor={`${id}-run-input`}>Run input (JSON)</Label>
                <Textarea
                  id={`${id}-run-input`}
                  rows={3}
                  value={draft.runInput}
                  onChange={(e) => onChange({ ...draft, runInput: e.target.value })}
                  placeholder={'{"env": "prod"}'}
                  aria-invalid={runInputBad}
                  className="font-mono text-xs"
                />
                {runInputBad
                  ? <p role="alert" className="text-xs text-danger-500">The run input is not valid JSON. Fix it, or empty the field.</p>
                  : <p className="text-xs text-muted">The workflow receives this input on each run. Leave it empty to send none.</p>}
              </div>
            </details>
          )}
        </div>
      )}

      {assistant && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-instructions`}>{required ? "Instructions (required)" : "Instructions (optional)"}</Label>
          <Textarea
            id={`${id}-instructions`}
            rows={3}
            value={draft.instructions}
            required={required}
            onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
            placeholder={routine ? "Summarize what changed overnight." : "If the check failed, find the failing job and summarize the cause."}
            className="min-h-[84px] resize-y"
          />
          <p className="text-xs text-muted">{routine ? "Plain words." : "Plain words. Valet also receives the event itself."}</p>
          {routine && <p className="text-xs text-muted">Valet sends this to the assistant each time the routine runs.</p>}
        </div>
      )}

      {assistant && !routine && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Advanced</summary>
          <div className="mt-2 grid gap-1">
            <Label htmlFor={`${id}-message`}>Event message (optional)</Label>
            <Textarea
              ref={box}
              id={`${id}-message`}
              rows={2}
              value={draft.promptTemplates.userPromptTemplate}
              onChange={(e) => onChange({ ...draft, promptTemplates: { userPromptTemplate: e.target.value } })}
              placeholder="{{event.key}}: {{event.summary}}"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="h-auto justify-self-start px-1 py-0 text-xs font-normal text-accent-600 dark:text-accent-400">
                  Insert a detail from the event
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {eventMessageDetails(draft, services).map((d) => (
                  <DropdownMenuItem key={d.template} onSelect={() => insert(d.template)}>{d.label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted">
              Leave it empty to send the default message. It can use <code>{"{{event.key}}"}</code>, <code>{"{{event.summary}}"}</code>,{" "}
              <code>{"{{event.body}}"}</code>, <code>{"{{refs.name}}"}</code>, and <code>{"{{payload.field}}"}</code> for a field the picked events carry.
            </p>
          </div>
        </details>
      )}

      {assistant && assistants.length > 1 && (
        <div role="radiogroup" aria-label="Assistant" className="grid gap-1.5">
          <p className="text-xs text-muted">Assistant</p>
          {assistants.map((a) => (
            <label key={a.value} className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name={`${id}-assistant`}
                disabled={stored || (fixedTeam && a.value !== "team")}
                checked={draft.assistant === a.value}
                onChange={() => onChange({ ...draft, assistant: a.value, teamId: a.teamId ?? null, where: null, whereChosen: false, whereTitle: undefined })}
              />
              {a.label}
            </label>
          ))}
        </div>
      )}

      {!stored && draft.doKind === "reply" && draft.assistant === "team" && (
        <div role="radiogroup" aria-label="Who can mention it" className="grid gap-1.5">
          <p className="text-xs text-muted">Who can mention it</p>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input type="radio" name={`${id}-audience`} checked={draft.audience === "organization"} onChange={() => onChange({ ...draft, audience: "organization" })} />
            Anyone in the organization
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input type="radio" name={`${id}-audience`} checked={draft.audience === "team"} onChange={() => onChange({ ...draft, audience: "team" })} />
            Only members of {teamName ?? "the team"}
          </label>
          <p className="text-xs text-muted">Everyone in the channel sees the replies. A sender outside the team gets no access to the team's threads or settings.</p>
        </div>
      )}
    </>
  );
}
