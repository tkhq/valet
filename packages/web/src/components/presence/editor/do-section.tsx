/**
 * The editor's **Do** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 4): the cards, the instructions, the workflow picker with a
 * routine's run input under Advanced, the event message under Advanced with
 * `Insert a detail from the event`, and the assistant choice when the
 * workspace offers more than one. `Run a plugin` shows when a plugin
 * declares event handlers: a handler picker and the handler's settings form.
 */
import { useId, useRef } from "react";
import { MAX_PROMPT_TEMPLATE_CHARS } from "@valet/shared";
import { useAutosizeTextarea } from "~/hooks/use-autosize-textarea";
import { fieldLabel } from "~/components/events/filter-editor";
import { unionFilterFields, type CatalogService } from "~/components/events/subscription-match";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  Select,
  Textarea,
} from "~/components/primitives";
import { HandlerSettingsForm, type HandlerOption } from "~/components/plugins/handler-settings";
import { cn } from "~/lib/cn";
import { selectsSlackMention } from "~/lib/slack-mention";
import type { WorkflowNames } from "../sentences";
import {
  characterCount,
  instructionsLength,
  instructionsTooLong,
  isAssistantDraft,
  parseRunInput,
  setHandler,
  type AssistantKind,
  type DoKind,
  type Draft,
  type EditorMode,
} from "./draft";

/** A line's instructions show their count from this length on, so the
 * limit is visible before the field reaches it. */
const COUNT_FROM = Math.floor(MAX_PROMPT_TEMPLATE_CHARS * 0.8);

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

function cards(routine: boolean, plugins: boolean): Card[] {
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
    ...(plugins ? [{ kind: "plugin" as const, title: "Run a plugin", line: "A plugin's event handler works on the event, with its own settings." }] : []),
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
  handlers,
  teamName,
}: {
  draft: Draft;
  mode: EditorMode;
  onChange: (next: Draft) => void;
  services: readonly CatalogService[];
  workflows: WorkflowNames;
  /** The assistants the workspace offers. One or none hides the choice. */
  assistants: readonly AssistantOption[];
  /** The plugin event handlers the reader may pick. None hides `Run a plugin`. */
  handlers: readonly HandlerOption[];
  /** The team's name, for who may mention a team assistant. */
  teamName?: string;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const instructionsBox = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(instructionsBox, draft.instructions);
  const routine = draft.service === "schedule";
  const stored = mode.kind !== "create";
  // The team Slack setup fixes the team's assistant.
  const fixedTeam = mode.kind === "create" && mode.preselected?.team !== undefined;
  // A workflow's panel fixes the workflow, so the line shows in that panel.
  const fixedWorkflowId = mode.kind === "create" ? mode.preselected?.fixedWorkflowId : undefined;
  const fixedWorkflow = fixedWorkflowId !== undefined;
  const fixedWorkflowName = workflows.find((w) => w.id === fixedWorkflowId)?.name ?? "this workflow";
  const runInputBad = parseRunInput(draft.runInput).kind === "bad";
  const assistant = isAssistantDraft(draft);
  const plugin = draft.doKind === "plugin";
  const required = routine && assistant;
  // Only a mention starts a conversation to reply in (Reply stores `follow`
  // only for a mention). A Slack line without one offers Work on it.
  const mention = selectsSlackMention([...draft.events]);
  const replyNeedsMention = !stored && !routine && draft.service === "slack" && !mention;
  const offered = cards(routine, handlers.length > 0 || plugin);
  const chosen = offered.find((card) => card.kind === draft.doKind);
  const handler = handlers.find((h) => h.plugin === draft.handler?.plugin && h.id === draft.handler?.handler);
  // A line's instructions have the api's limit; a routine's have none.
  const tooLong = instructionsTooLong(draft);
  const length = instructionsLength(draft);
  const counted = !routine && tooLong === null && length >= COUNT_FROM;
  const limitId = `${id}-instructions-limit`;

  function pick(kind: DoKind) {
    if (kind === draft.doKind || fixedWorkflow) return;
    const first = handlers[0];
    if (kind === "plugin" && first !== undefined) {
      onChange(setHandler({ ...draft, where: null, whereChosen: false, whereTitle: undefined }, first, services));
      return;
    }
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
      {stored ? (
        // What a stored line does is fixed (a PATCH cannot change it), so
        // the page shows the one choice, with how to change it inside it.
        <div className="grid gap-1 rounded-lg border border-line px-3.5 py-3">
          <span className="text-[15px] font-medium text-ink">{chosen?.title}</span>
          <span className="text-[13px] leading-snug text-muted">{chosen?.line}</span>
          <span className="mt-1 text-xs text-muted">
            This stays fixed. To change it, delete this {routine ? "routine" : "line"} and make a new one.
          </span>
        </div>
      ) : (
        <div role="radiogroup" aria-label="Do" className={cn("grid gap-2.5", offered.length === 4 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
          {offered.map((card) => {
            const on = draft.doKind === card.kind;
            // A Reply already picked stays open, so the reader can see it and move off it.
            const off = (fixedWorkflow && card.kind !== "workflow") || (card.kind === "reply" && (draft.service !== "slack" || (replyNeedsMention && !on)));
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
      )}
      {replyNeedsMention && !fixedWorkflow && (
        <p className="text-xs text-muted">Reply answers a mention. To reply, pick the mention in When.</p>
      )}

      {draft.doKind === "workflow" && (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-workflow`}>Workflow</Label>
          <Select
            id={`${id}-workflow`}
            value={draft.workflowId}
            disabled={stored || fixedWorkflow}
            onChange={(e) => onChange({ ...draft, workflowId: e.target.value })}
            className="w-full min-w-0 truncate"
          >
            <option value="">Pick a workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            {/* The fixed workflow reads by name before the list loads. */}
            {fixedWorkflowId !== undefined && !workflows.some((w) => w.id === fixedWorkflowId) && (
              <option value={fixedWorkflowId}>{fixedWorkflowName}</option>
            )}
          </Select>
          {fixedWorkflow && (
            <p className="text-xs text-muted">
              This {routine ? "routine" : "line"} starts {fixedWorkflowName}. To pick another workflow, add the {routine ? "routine" : "line"} from Presence.
            </p>
          )}
          {workflows.length === 0 && !fixedWorkflow && (
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

      {plugin && (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-handler`}>Plugin handler</Label>
            <Select
              id={`${id}-handler`}
              value={draft.handler === null ? "" : `${draft.handler.plugin}/${draft.handler.handler}`}
              disabled={stored}
              onChange={(e) => {
                const next = handlers.find((h) => `${h.plugin}/${h.id}` === e.target.value);
                if (next !== undefined) onChange(setHandler(draft, next, services));
              }}
              className="w-full min-w-0 truncate"
            >
              {draft.handler === null && <option value="">Pick a handler</option>}
              {handlers.map((h) => <option key={`${h.plugin}/${h.id}`} value={`${h.plugin}/${h.id}`}>{h.label}</option>)}
              {/* A stored handler reads by its ids before the plugins load, or after its plugin is gone. */}
              {draft.handler !== null && handler === undefined && (
                <option value={`${draft.handler.plugin}/${draft.handler.handler}`}>{`${draft.handler.plugin}: ${draft.handler.handler}`}</option>
              )}
            </Select>
            {handler !== undefined && <p className="text-xs text-muted">{handler.description}</p>}
          </div>
          {handler?.configSchema !== undefined && (
            <div className="grid gap-2 rounded-lg border border-line px-3.5 py-3">
              <p className="text-xs text-muted">Settings</p>
              <HandlerSettingsForm schema={handler.configSchema} value={draft.handlerConfig} onChange={(handlerConfig) => onChange({ ...draft, handlerConfig })} />
            </div>
          )}
        </div>
      )}

      {assistant && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-instructions`}>{required ? "Instructions (required)" : "Instructions (optional)"}</Label>
          {/* Six rows at least, and it grows with the text, so a long prompt reads whole. */}
          <Textarea
            ref={instructionsBox}
            id={`${id}-instructions`}
            rows={6}
            value={draft.instructions}
            required={required}
            onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
            placeholder={routine ? "Summarize what changed overnight." : "If the check failed, find the failing job and summarize the cause."}
            aria-invalid={tooLong !== null}
            aria-describedby={tooLong !== null || counted ? limitId : undefined}
            className={cn("resize-none overflow-hidden", tooLong !== null && "border-danger-500 focus-visible:ring-danger-500/40")}
          />
          {/* No live region: the count changes with each key, and the field's
              description already carries it. */}
          {tooLong !== null && <p id={limitId} className="text-xs text-danger-500">{tooLong}</p>}
          {counted && (
            <p id={limitId} className="text-xs tabular-nums text-muted">
              {characterCount(length)} of {characterCount(MAX_PROMPT_TEMPLATE_CHARS)} characters
            </p>
          )}
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

      {(assistant || plugin) && assistants.filter((a) => assistant || a.value !== "org").length > 1 && (
        <div role="radiogroup" aria-label="Assistant" className="grid gap-1.5">
          <p className="text-xs text-muted">Assistant</p>
          {assistants.filter((a) => assistant || a.value !== "org").map((a) => (
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
