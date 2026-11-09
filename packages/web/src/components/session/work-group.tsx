import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, Bot, Brain, CheckCheck, Lightbulb } from "lucide-react";
import type { MessagePart } from "@valet/api/wire";
import { serviceDisplayName } from "@valet/api/service-display-name";
import { deriveActionLabel, deriveMcpToolLabel, readSources } from "@valet/shared";
import { Markdown } from "~/components/markdown";
import { ServiceGlyph } from "~/components/service-icon";
import { TraceLine, TraceList, TraceStep, type TraceStatus } from "~/components/primitives";
import { getToolCardDefault } from "~/lib/preferences";
import { SourceList } from "./source-list";
import { useThreadSources } from "./citations";
import { resultText } from "./tool-renderers/types";
import { ToolCallBlock, type ToolCallPart } from "./tool-call-block";
import { pickRenderer } from "./tool-renderers";
import { prettyToolName } from "./tool-renderers/tool-shell";

/**
 * A thread's tool calls as quiet lines instead of a stack of cards (after
 * Claude's tool group and the shadcn/ui Trace pattern). Consecutive calls
 * fold into one line that says what happened ("Read 3 files, ran 2
 * commands"); it opens into a timeline with one step per call, and a step
 * opens into the call's full card. A call whose output must stay in view
 * (a renderer with a `Preview`, or a `bare` card) keeps its own card.
 */

type ThinkingPart = Extract<MessagePart, { kind: "thinking" }>;
export type WorkPart = ToolCallPart | ThinkingPart;

export type Segment =
  | { kind: "work"; parts: WorkPart[] }
  | { kind: "part"; part: MessagePart };

/** A call that folds into a work line: its output does not need to stay in view. */
export function isQuietCall(part: MessagePart): part is ToolCallPart {
  if (part.kind !== "tool_call") return false;
  const renderer = pickRenderer(part.toolName, part.args);
  if (renderer.bare) return false;
  if (!renderer.Preview) return true;
  return renderer.keepsInView ? !renderer.keepsInView(part.args, part.toolName) : false;
}

/** Pure: runs of quiet calls and thinking become work segments; everything else stays a part. */
export function segmentParts(parts: readonly MessagePart[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    const work = part.kind === "thinking" || isQuietCall(part);
    const last = out.at(-1);
    if (work && last?.kind === "work") last.parts.push(part);
    else if (work) out.push({ kind: "work", parts: [part] });
    else out.push({ kind: "part", part });
  }
  return out;
}

/** Pure: adds quiet calls from the next messages of a turn to the last work segment. */
export function withExtraWork(segments: Segment[], extra: readonly WorkPart[] | undefined): Segment[] {
  if (!extra?.length) return segments;
  const last = segments.at(-1);
  if (last?.kind === "work") return [...segments.slice(0, -1), { kind: "work", parts: [...last.parts, ...extra] }];
  return [...segments, { kind: "work", parts: [...extra] }];
}

/** A stable key for a work segment: its first call's id, which streaming never changes. */
export function workKey(parts: readonly WorkPart[], index: number): string {
  const first = parts.find((part): part is ToolCallPart => part.kind === "tool_call");
  return first ? `work-${first.callId}` : `work-${index}`;
}

/** Pure: how many leading parts of a message belong to a work run (quiet calls and thinking). */
export function leadingWorkCount(parts: readonly MessagePart[]): number {
  let n = 0;
  while (n < parts.length && (parts[n]!.kind === "thinking" || isQuietCall(parts[n]!))) n++;
  return n;
}

/** Child sessions by id, for "Messaged <child title>" instead of a raw id. */
export const ChildTitlesContext = createContext<ReadonlyMap<string, string>>(new Map());

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown, max = 160): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined;
}

/** The plugin action a call runs: `call_tool` names it in `tool_id`; a pinned tool carries it as `service__action`. */
export function pluginAction(part: ToolCallPart): { service: string; action: string } | undefined {
  const id = part.toolName === "call_tool" ? str(record(part.args)?.tool_id) : part.toolName.includes("__") ? part.toolName.replace("__", ".") : undefined;
  const dot = id?.indexOf(".") ?? -1;
  if (!id || dot <= 0) return undefined;
  return { service: id.slice(0, dot), action: id.slice(dot + 1) };
}

type Verb = "searched" | "read" | "changed" | "used";

/** What an action does to its service, from its name. */
export function actionVerb(action: string): Verb {
  if (/search|find|lookup|query/.test(action)) return "searched";
  if (/^(get|read|fetch|list|describe|view|show)|_(get|read|fetch|list)|-(get|fetch|read)|history|summary|transcript|info|pins/.test(action)) return "read";
  if (/create|update|send|post|save|patch|delete|move|join|dm|write|add|remove|start|edit|set|reply|upload|publish/.test(action)) return "changed";
  return "used";
}

const VERB_TEXT: Record<Verb, [present: string, past: string]> = {
  searched: ["Searching", "Searched"],
  read: ["Reading", "Read"],
  changed: ["Updating", "Updated"],
  used: ["Using", "Used"],
};

/** Built-in tools, by name: what the step says while it runs and once it is done. */
const BUILTIN: Record<string, [present: string, past: string]> = {
  bash: ["Running", "Ran"],
  read: ["Reading", "Read"],
  write: ["Writing", "Wrote"],
  edit: ["Editing", "Edited"],
  find_replace: ["Editing", "Edited"],
  mem_read: ["Reading memory", "Read memory"],
  mem_search: ["Searching memory for", "Searched memory for"],
  mem_write: ["Saving to memory", "Saved to memory"],
  mem_patch: ["Updating memory", "Updated memory"],
  thread_read: ["Reading a thread", "Read a thread"],
  update_plan: ["Updating the plan", "Updated the plan"],
  list_tools: ["Looking up tools", "Looked up tools"],
  focus_tools: ["Looking up tools", "Looked up tools"],
  search_tools: ["Looking up tools", "Looked up tools"],
  describe_tool: ["Looking up a tool", "Looked up a tool"],
  ask_question: ["Asking you", "Asked you"],
  wake_at: ["Setting a wake-up", "Set a wake-up"],
  wakeup_list: ["Checking wake-ups", "Checked wake-ups"],
  wakeup_cancel: ["Canceling a wake-up", "Canceled a wake-up"],
  artifact_publish: ["Publishing", "Published"],
  switch_model: ["Switching the model", "Switched the model"],
  ask_approval: ["Asking for approval", "Asked for approval"],
  hold_sandbox: ["Keeping the sandbox running", "Kept the sandbox running"],
  list_threads: ["Listing threads", "Listed threads"],
  list_linked_threads: ["Listing linked threads", "Listed linked threads"],
  message_linked_thread: ["Messaging a linked thread", "Messaged a linked thread"],
  list_tasks: ["Listing tasks", "Listed tasks"],
  read_task: ["Reading a task", "Read a task"],
  start_task: ["Starting a task", "Started a task"],
  message_task: ["Messaging a task", "Messaged a task"],
  mark_task_done: ["Marking a task done", "Marked a task done"],
  show_brief: ["Showing the brief", "Showed the brief"],
  show_widget: ["Showing a widget", "Showed a widget"],
  mem_copy_to_team: ["Copying memory to the team", "Copied memory to the team"],
  mem_copy_from_team: ["Copying memory from the team", "Copied memory from the team"],
  mem_links: ["Reading memory links", "Read memory links"],
  mem_move: ["Moving memory", "Moved memory"],
  mem_rm: ["Removing memory", "Removed memory"],
  mem_share: ["Sharing memory", "Shared memory"],
  save_principle: ["Saving a principle", "Saved a principle"],
  artifact_comments: ["Reading page comments", "Read page comments"],
  artifact_copy_to_team: ["Copying a page to the team", "Copied a page to the team"],
  process_read: ["Reading process output", "Read process output"],
  wait_for_event: ["Waiting for an event", "Waited for an event"],
  watch: ["Watching a command", "Watched a command"],
  file_attach: ["Attaching a file", "Attached a file"],
  skill_script: ["Running a skill script", "Ran a skill script"],
  call_tool: ["Calling a tool", "Called a tool"],
  sec_start: ["Starting a security run", "Started a security run"],
  sec_status: ["Checking the security run", "Checked the security run"],
  sec_close: ["Closing the security run", "Closed the security run"],
  sec_plan_set: ["Setting the security plan", "Set the security plan"],
  sec_dispatch: ["Dispatching security cells", "Dispatched security cells"],
  sec_handoff: ["Handing off security work", "Handed off security work"],
  sec_protocol_read: ["Reading the security protocol", "Read the security protocol"],
  sec_fs_list: ["Listing security files", "Listed security files"],
  sec_fs_read: ["Reading a security file", "Read a security file"],
  sec_fs_write: ["Writing a security file", "Wrote a security file"],
  sec_cell_complete: ["Completing a security cell", "Completed a security cell"],
  sec_cell_fail: ["Failing a security cell", "Marked a security cell failed"],
  sec_need_report: ["Reporting a security need", "Reported a security need"],
  sec_finding_report: ["Reporting a security finding", "Reported a security finding"],
  sec_finding_review: ["Reviewing a security finding", "Reviewed a security finding"],
  sec_findings_list: ["Listing security findings", "Listed security findings"],
  sec_coverage_report: ["Reporting security coverage", "Reported security coverage"],
  sec_report_write: ["Writing the security report", "Wrote the security report"],
};

/** Tools whose target says nothing a reader needs: the verb is the whole line. */
const NO_TARGET = new Set([
  "list_tools", "focus_tools", "thread_read", "update_plan", "wakeup_list", "switch_model", "ask_question",
  "ask_approval", "hold_sandbox", "list_threads", "list_linked_threads", "message_linked_thread", "list_tasks", "read_task",
  "start_task", "message_task", "mark_task_done", "show_brief", "show_widget", "process_read", "wait_for_event", "watch", "call_tool", "skill_script",
  "mem_copy_to_team", "mem_copy_from_team", "save_principle", "artifact_copy_to_team", "file_attach",
]);

const CHILD_VERBS: Record<string, [present: string, past: string]> = {
  child_send: ["Messaging", "Messaged"],
  child_read: ["Reading", "Read"],
  child_status: ["Checking", "Checked"],
  child_stop: ["Stopping", "Stopped"],
};

export interface StepView {
  icon: ReactNode;
  title: string;
  detail?: string;
  status: TraceStatus;
}

function stepStatus(part: ToolCallPart): TraceStatus {
  const result = record(part.result);
  const failed = result?.ok === false || record(result?.details)?.ok === false;
  return part.status === "error" || failed ? "error" : part.status === "completed" ? "done" : "running";
}

/** Pure-ish: the line a call shows, from its name, its args, and the children of this thread. */
/** Pure: the call needed approval and ran without a card because its
 * thread runs without asking (`details.approval` from the engine). */
export function approvedAutomatically(part: ToolCallPart): boolean {
  const result = record(part.result);
  return record(result?.details)?.approval === "automatic";
}

/** Pure: the line the action wrote for its finished call (`details.label`
 * from the engine): what it did, with the key inputs. */
export function actionLabel(part: ToolCallPart): string | undefined {
  return part.status === "completed" ? str(record(record(part.result)?.details)?.label) : undefined;
}

export function stepView(part: ToolCallPart, childTitles: ReadonlyMap<string, string>): StepView {
  const renderer = pickRenderer(part.toolName, part.args);
  const status = stepStatus(part);
  const running = status === "running";
  const args = record(part.args);
  const Icon = renderer.Icon;
  const error = status === "error" ? str((part.error || resultText(part.result)).split("\n")[0], 90) : undefined;
  const summary = status === "done" ? renderer.formatSummary?.(part.args, part.result, part.status, part.toolName) : undefined;
  const detail = error ?? summary;

  const action = pluginAction(part);
  if (action) {
    const name = serviceDisplayName(action.service);
    // A finished call shows the action's own line, else the line built from
    // the action name and args. A running call shows the agent's one-line
    // purpose first, because the action has not written its line yet. The
    // tool name is the last resort.
    // A failed call did not do the thing, so its line stays in the present
    // tense and the error shows beside it, as the engine reports it.
    const tense = status === "done" ? "past" : "present";
    const params = part.toolName === "call_tool" ? record(args?.params) : args;
    const purpose = str(args?.summary, 120);
    const derived = deriveActionLabel(action.service, `${action.service}.${action.action}`, params, tense);
    const label = running
      ? purpose ?? derived ?? deriveMcpToolLabel(action.service, action.action, params, tense)
      : status === "error"
        ? derived ?? purpose ?? deriveMcpToolLabel(action.service, action.action, params, tense)
        : actionLabel(part) ?? derived ?? purpose ?? deriveMcpToolLabel(action.service, action.action, params, tense);
    return {
      icon: <ServiceGlyph service={action.service} fallback={<Icon />} />,
      title: label,
      detail: [detail ?? name, approvedAutomatically(part) ? "Approved automatically" : undefined].filter(Boolean).join(" · ") || undefined,
      status,
    };
  }

  if (part.toolName === "task") {
    const title = str(args?.title, 100) ?? "a task";
    return { icon: <Bot />, title: `${running ? "Starting" : "Started"} ${title}`, detail, status };
  }
  const childVerb = CHILD_VERBS[part.toolName];
  if (childVerb) {
    const id = str(args?.child_session_id) ?? str(args?.child_id) ?? str(args?.session_id);
    const name = (id && childTitles.get(id)) ?? "an agent";
    return { icon: <Bot />, title: `${running ? childVerb[0] : childVerb[1]} ${name}`, detail, status };
  }

  // Streaming args are jagged until the call starts, so the target waits for them.
  // Destructive memory calls name the files they touch.
  const memPath = part.toolName === "mem_rm" ? str(args?.path, 120)
    : part.toolName === "mem_move" && str(args?.from, 120) && str(args?.to, 120) ? `${str(args?.from, 120)} → ${str(args?.to, 120)}` : undefined;
  const target = NO_TARGET.has(part.toolName) || part.status === "streaming" ? undefined : memPath ?? renderer.formatTarget(part.args, part.toolName);
  if (part.toolName === "skill") {
    return { icon: <Icon />, title: `${running ? "Using" : "Used"} ${target ? `the ${target} skill` : "a skill"}`, detail, status };
  }
  const verbs = BUILTIN[part.toolName];
  const base = verbs ? (running ? verbs[0] : verbs[1]) : `${running ? "Using" : "Used"} ${prettyToolName(part.toolName)}`;
  return { icon: <Icon />, title: target ? `${base} ${target}` : base, detail, status };
}

type Phrase = { key: string; text: (n: number) => string };

/** Pure: the phrase a call adds to its group's summary. Calls with the same key count together. */
export function summaryPhrase(part: ToolCallPart): Phrase {
  const action = pluginAction(part);
  if (action) {
    const verb = actionVerb(action.action);
    const name = serviceDisplayName(action.service);
    return { key: `${verb}:${action.service}`, text: () => `${VERB_TEXT[verb][1].toLowerCase()} ${name}` };
  }
  switch (part.toolName) {
    case "bash": return { key: "bash", text: n => n === 1 ? "ran a command" : `ran ${n} commands` };
    case "read": return { key: "read", text: n => n === 1 ? "read a file" : `read ${n} files` };
    case "write": case "edit": case "find_replace": return { key: "edit", text: n => n === 1 ? "edited a file" : `edited ${n} files` };
    case "mem_read": return { key: "mem-read", text: n => n === 1 ? "read a memory file" : `read ${n} memory files` };
    case "mem_search": return { key: "mem-search", text: n => n === 1 ? "searched memory" : `searched memory ${n} times` };
    case "mem_write": case "mem_patch": return { key: "mem-write", text: () => "updated memory" };
    case "skill": {
      const name = str(record(part.args)?.name);
      return { key: `skill:${name ?? ""}`, text: () => name ? `used the ${name} skill` : "used a skill" };
    }
    case "list_tools": case "focus_tools": case "search_tools": case "describe_tool": return { key: "tools", text: () => "looked up tools" };
    case "task": return { key: "task", text: n => n === 1 ? "started an agent" : `started ${n} agents` };
    case "child_send": return { key: "child-send", text: n => n === 1 ? "messaged an agent" : `messaged ${n} agents` };
    case "child_read": case "child_status": return { key: "child-read", text: () => "checked on agents" };
    case "child_stop": return { key: "child-stop", text: n => n === 1 ? "stopped an agent" : `stopped ${n} agents` };
    case "update_plan": return { key: "plan", text: () => "updated the plan" };
    case "thread_read": return { key: "thread", text: n => n === 1 ? "read a thread" : `read ${n} threads` };
    default: {
      const verbs = BUILTIN[part.toolName];
      if (verbs) return { key: `tool:${part.toolName}`, text: n => `${verbs[1].toLowerCase()}${n > 1 ? ` ${n} times` : ""}` };
      return { key: `tool:${part.toolName}`, text: n => `used ${prettyToolName(part.toolName)}${n > 1 ? ` ${n} times` : ""}` };
    }
  }
}

/** Pure: "Read 3 files, ran 2 commands, and searched Notion". Plugin
 * actions with the same verb share one phrase ("read GitHub and Notion").
 * Thinking adds nothing. */
export function workSummary(parts: readonly WorkPart[]): string {
  const counts = new Map<string, { phrase: Phrase; n: number }>();
  const services = new Map<Verb, string[]>();
  for (const part of parts) {
    if (part.kind !== "tool_call") continue;
    const action = pluginAction(part);
    if (action) {
      const verb = actionVerb(action.action);
      const names = services.get(verb) ?? [];
      const name = serviceDisplayName(action.service);
      if (!names.includes(name)) names.push(name);
      services.set(verb, names);
      if (!counts.has(`verb:${verb}`)) counts.set(`verb:${verb}`, { phrase: { key: verb, text: () => `${VERB_TEXT[verb][1].toLowerCase()} ${listText(services.get(verb)!)}` }, n: 1 });
      continue;
    }
    const phrase = summaryPhrase(part);
    const entry = counts.get(phrase.key);
    if (entry) entry.n++;
    else counts.set(phrase.key, { phrase, n: 1 });
  }
  const texts = [...counts.values()].map(({ phrase, n }) => phrase.text(n));
  if (texts.length === 0) return "Thought it through";
  const shown = texts.length > 4 ? [...texts.slice(0, 3), `${texts.length - 3} more`] : texts;
  const joined = listText(shown);
  return joined[0]!.toUpperCase() + joined.slice(1);
}

/** "A", "A and B", or "A, B, and C". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** What a thought row opens to: the provider's reasoning summary, or the
 * reasoning text older messages stored before summaries existed. */
export function reasoningText(part: ThinkingPart): string {
  return part.summary || part.text;
}

function reasoningTitle(part: ThinkingPart): string {
  return part.durationMs !== undefined && Number.isFinite(part.durationMs) && part.durationMs >= 0
    ? `Thought for ${Math.round(part.durationMs / 1000)}s`
    : "Thought process";
}

/** A model's reasoning, as one quiet line: "Thinking…" while it streams, then it opens to the text. */
export function ReasoningLine({ part, live }: { part: ThinkingPart; live: boolean }) {
  const running = live && part.durationMs === undefined;
  const text = reasoningText(part);
  if (!text && !running && part.durationMs === undefined) return null;
  return <TraceLine icon={<Lightbulb />} title={running ? "Thinking…" : reasoningTitle(part)} status={running ? "running" : "done"} label={running ? undefined : "Show the thought process"}>
    {text ? <div className="border-l border-line pl-3 text-sm text-muted"><Markdown>{text}</Markdown></div> : undefined}
  </TraceLine>;
}

/**
 * A run of tool calls (and the reasoning between them) as one line. One
 * call shows as its own step; two or more fold behind a summary. `live`
 * marks the run the agent is still adding to.
 */
export function WorkGroup({ parts, live, readOnly = false }: { parts: readonly WorkPart[]; live: boolean; readOnly?: boolean }) {
  const childTitles = useContext(ChildTitlesContext);
  const { reveal } = useThreadSources();
  const calls = parts.filter((part): part is ToolCallPart => part.kind === "tool_call");
  if (calls.length === 0) {
    const thinking = parts.filter((part): part is ThinkingPart => part.kind === "thinking");
    if (thinking.length === 0) return null;
    const measured = thinking.every(part => part.durationMs !== undefined && Number.isFinite(part.durationMs) && part.durationMs >= 0);
    const combined: ThinkingPart = {
      kind: "thinking",
      text: thinking.map(reasoningText).filter(Boolean).join("\n\n"),
      ...(measured ? { durationMs: thinking.reduce((sum, part) => sum + (part.durationMs ?? 0), 0) } : {}),
    };
    return <ReasoningLine part={combined} live={live} />;
  }
  if (parts.length === 1) return <CallStep part={calls[0]!} childTitles={childTitles} readOnly={readOnly} single />;

  const running = calls.find(call => call.status === "running" || call.status === "streaming");
  const failed = calls.filter(call => stepStatus(call) === "error").length;
  const automatic = calls.filter(approvedAutomatically).length;
  const status: TraceStatus = running ? "running" : "done";
  const title = running ? `${stepView(running, childTitles).title}…` : workSummary(parts);
  const expanded = getToolCardDefault() === "always-expanded";
  return <TraceLine icon={running ? <Brain /> : <CheckCheck />} title={title} status={status}
    detail={failed > 0 ? <span className="text-danger-600 dark:text-danger-500">{failed} failed</span>
      : [calls.length === 1 ? "1 step" : `${calls.length} steps`, automatic > 0 ? `${automatic} approved automatically` : undefined].filter(Boolean).join(" · ")}
    keepDetail={failed > 0}
    defaultOpen={expanded} revealKey={reveal && calls.some(call => call.callId === reveal.callId) ? reveal.key : undefined}>
    <TraceList>
      {parts.map((part, i) => part.kind === "thinking"
        ? reasoningText(part) || part.durationMs !== undefined ? <TraceStep key={`t-${i}`} icon={<Lightbulb />} title={reasoningTitle(part)} label="Show the thought process">
          {reasoningText(part) ? <div className="border-l border-line pl-3 text-sm text-muted"><Markdown>{reasoningText(part)}</Markdown></div> : undefined}
        </TraceStep> : null
        : <CallStep key={part.callId} part={part} childTitles={childTitles} readOnly={readOnly} />)}
    </TraceList>
  </TraceLine>;
}

/** Pure: runs of calls that add the same phrase to a summary ("read 4 memory files"). */
export function groupCalls(calls: readonly ToolCallPart[]): ToolCallPart[][] {
  const groups: ToolCallPart[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    if (last && summaryPhrase(last[0]!).key === summaryPhrase(call).key) last.push(call);
    else groups.push([call]);
  }
  return groups;
}

/**
 * A turn's calls as a timeline, for the task card. Repeated calls fold into
 * one step that opens to each call; a call opens into its full card.
 */
export function CallSteps({ calls, readOnly = false }: { calls: readonly ToolCallPart[]; readOnly?: boolean }) {
  const childTitles = useContext(ChildTitlesContext);
  const { reveal } = useThreadSources();
  const expanded = getToolCardDefault() === "always-expanded";
  return <TraceList>
    {groupCalls(calls).map(group => {
      const first = group[0]!;
      if (group.length === 1) return <CallStep key={first.callId} part={first} childTitles={childTitles} readOnly={readOnly} />;
      const running = group.find(call => call.status === "running" || call.status === "streaming");
      const failed = group.filter(call => stepStatus(call) === "error").length;
      return <TraceStep key={first.callId} icon={stepView(first, childTitles).icon} status={running ? "running" : "done"}
        title={running ? `${stepView(running, childTitles).title}…` : workSummary(group)}
        detail={failed > 0 ? <span className="text-danger-600 dark:text-danger-500">{failed} failed</span> : `${group.length} steps`}
        keepDetail={failed > 0} defaultOpen={expanded} revealKey={reveal && group.some(call => call.callId === reveal.callId) ? reveal.key : undefined}>
        <TraceList>{group.map(call => <CallStep key={call.callId} part={call} childTitles={childTitles} readOnly={readOnly} />)}</TraceList>
      </TraceStep>;
    })}
  </TraceList>;
}

/** One call as a step that opens into its full card. */
function CallStep({ part, childTitles, single = false, readOnly = false }: { part: ToolCallPart; childTitles: ReadonlyMap<string, string>; single?: boolean; readOnly?: boolean }) {
  const { reveal, focusStep } = useThreadSources();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const revealKey = reveal?.callId === part.callId ? reveal.key : undefined;
  useEffect(() => {
    if (revealKey !== undefined && reveal && buttonRef.current) focusStep(buttonRef.current, reveal);
  }, [revealKey, reveal, focusStep]);
  const view = stepView(part, childTitles);
  const sources = readSources(part.result);
  const detail = [view.detail, sources.length === 1 ? "1 source" : sources.length > 1 ? `${sources.length} sources` : undefined].filter(Boolean).join(" · ");
  const Line = single ? TraceLine : TraceStep;
  return <Line icon={view.status === "error" ? <AlertCircle /> : view.icon} title={view.title} detail={detail || undefined} status={view.status}
    defaultOpen={getToolCardDefault() === "always-expanded"} revealKey={revealKey} buttonRef={buttonRef}>
    <SourceList sources={sources} revealSourceId={revealKey !== undefined ? reveal?.sourceId : undefined} revealKey={revealKey} />
    <ToolCallBlock part={view.status === "error" ? { ...part, status: "error", error: part.error || resultText(part.result) || undefined } : part} readOnly={readOnly} revealKey={revealKey} />
  </Line>;
}
