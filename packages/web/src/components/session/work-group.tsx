import { createContext, useContext, type ReactNode } from "react";
import { AlertCircle, Bot, Brain, CheckCheck, Lightbulb } from "lucide-react";
import type { MessagePart } from "@valet/api/wire";
import { serviceDisplayName } from "@valet/api/service-display-name";
import { Markdown } from "~/components/markdown";
import { brandMark, pluginGlyph } from "~/components/service-icon";
import { TraceLine, TraceList, TraceStep, type TraceStatus } from "~/components/primitives";
import { getToolCardDefault } from "~/lib/preferences";
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
};

/** Tools whose target says nothing a reader needs: the verb is the whole line. */
const NO_TARGET = new Set(["list_tools", "focus_tools", "thread_read", "update_plan", "wakeup_list", "switch_model", "ask_question"]);

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
  return part.status === "error" ? "error" : part.status === "completed" ? "done" : "running";
}

function ServiceGlyph({ service, fallback }: { service: string; fallback: ReactNode }) {
  const mark = brandMark(service);
  if (mark) return <svg viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d={mark.path} /></svg>;
  const Glyph = pluginGlyph(service);
  return Glyph ? <Glyph focusable="false" /> : <>{fallback}</>;
}

/** Pure-ish: the line a call shows, from its name, its args, and the children of this thread. */
/** Pure: the call needed approval and ran without a card because its
 * thread runs without asking (`details.approval` from the engine). */
export function approvedAutomatically(part: ToolCallPart): boolean {
  const result = record(part.result);
  return record(result?.details)?.approval === "automatic";
}

export function stepView(part: ToolCallPart, childTitles: ReadonlyMap<string, string>): StepView {
  const renderer = pickRenderer(part.toolName, part.args);
  const status = stepStatus(part);
  const running = status === "running";
  const args = record(part.args);
  const Icon = renderer.Icon;
  const error = status === "error" ? str(part.error?.split("\n")[0], 90) : undefined;
  const summary = status === "done" ? renderer.formatSummary?.(part.args, part.result, part.status, part.toolName) : undefined;
  const detail = error ?? summary;

  const action = pluginAction(part);
  if (action) {
    const [present, past] = VERB_TEXT[actionVerb(action.action)];
    const name = serviceDisplayName(action.service);
    // The agent writes a one-line purpose for each plugin call. It says more than the action id.
    const purpose = str(args?.summary, 120);
    return {
      icon: <ServiceGlyph service={action.service} fallback={<Icon />} />,
      title: purpose ?? `${running ? present : past} ${name} · ${action.action.replace(/[_-]+/g, " ")}`,
      detail: [detail ?? (purpose ? name : undefined), approvedAutomatically(part) ? "Approved automatically" : undefined].filter(Boolean).join(" · ") || undefined,
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
  const target = NO_TARGET.has(part.toolName) || part.status === "streaming" ? undefined : renderer.formatTarget(part.args, part.toolName);
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
    case "mem_read": case "mem_search": return { key: "mem-read", text: () => "checked memory" };
    case "mem_write": case "mem_patch": return { key: "mem-write", text: () => "updated memory" };
    case "skill": {
      const name = str(record(part.args)?.name);
      return { key: `skill:${name ?? ""}`, text: () => name ? `used the ${name} skill` : "used a skill" };
    }
    case "list_tools": case "focus_tools": case "search_tools": case "describe_tool": return { key: "tools", text: () => "looked up tools" };
    case "task": return { key: "task", text: n => n === 1 ? "started an agent" : `started ${n} agents` };
    case "child_send": return { key: "child-send", text: n => n === 1 ? "messaged an agent" : `messaged ${n} agents` };
    case "child_read": case "child_status": return { key: "child-read", text: () => "checked on agents" };
    case "update_plan": return { key: "plan", text: () => "updated the plan" };
    case "thread_read": return { key: "thread", text: n => n === 1 ? "read a thread" : `read ${n} threads` };
    default: return { key: `tool:${part.toolName}`, text: n => `used ${prettyToolName(part.toolName)}${n > 1 ? ` ${n} times` : ""}` };
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

function reasoningTitle(part: ThinkingPart): string {
  return part.durationMs !== undefined && Number.isFinite(part.durationMs) && part.durationMs >= 0
    ? `Thought for ${Math.round(part.durationMs / 1000)}s`
    : "Thought process";
}

/** A model's reasoning, as one quiet line: "Thinking…" while it streams, then it opens to the text. */
export function ReasoningLine({ part, live }: { part: ThinkingPart; live: boolean }) {
  const running = live && part.durationMs === undefined;
  if (!part.text && !running && part.durationMs === undefined) return null;
  return <TraceLine icon={<Lightbulb />} title={running ? "Thinking…" : reasoningTitle(part)} status={running ? "running" : "done"} label={running ? undefined : "Show the thought process"}>
    {part.text ? <div className="border-l border-line pl-3 text-sm text-muted"><Markdown>{part.text}</Markdown></div> : undefined}
  </TraceLine>;
}

/**
 * A run of tool calls (and the reasoning between them) as one line. One
 * call shows as its own step; two or more fold behind a summary. `live`
 * marks the run the agent is still adding to.
 */
export function WorkGroup({ parts, live, readOnly = false }: { parts: readonly WorkPart[]; live: boolean; readOnly?: boolean }) {
  const childTitles = useContext(ChildTitlesContext);
  const calls = parts.filter((part): part is ToolCallPart => part.kind === "tool_call");
  if (calls.length === 0) {
    const thinking = parts.filter((part): part is ThinkingPart => part.kind === "thinking");
    if (thinking.length === 0) return null;
    const measured = thinking.every(part => part.durationMs !== undefined && Number.isFinite(part.durationMs) && part.durationMs >= 0);
    const combined: ThinkingPart = {
      kind: "thinking",
      text: thinking.map(part => part.text).filter(Boolean).join("\n\n"),
      ...(measured ? { durationMs: thinking.reduce((sum, part) => sum + (part.durationMs ?? 0), 0) } : {}),
    };
    return <ReasoningLine part={combined} live={live} />;
  }
  if (parts.length === 1) return <CallStep part={calls[0]!} childTitles={childTitles} readOnly={readOnly} single />;

  const running = calls.find(call => call.status === "running" || call.status === "streaming");
  const failed = calls.filter(call => call.status === "error").length;
  const automatic = calls.filter(approvedAutomatically).length;
  const status: TraceStatus = running ? "running" : "done";
  const title = running ? `${stepView(running, childTitles).title}…` : workSummary(parts);
  const expanded = getToolCardDefault() === "always-expanded";
  return <TraceLine icon={running ? <Brain /> : <CheckCheck />} title={title} status={status}
    detail={failed > 0 ? <span className="text-danger-600 dark:text-danger-500">{failed} failed</span>
      : [calls.length === 1 ? "1 step" : `${calls.length} steps`, automatic > 0 ? `${automatic} approved automatically` : undefined].filter(Boolean).join(" · ")}
    keepDetail={failed > 0}
    defaultOpen={expanded}>
    <TraceList>
      {parts.map((part, i) => part.kind === "thinking"
        ? part.text || part.durationMs !== undefined ? <TraceStep key={`t-${i}`} icon={<Lightbulb />} title={reasoningTitle(part)} label="Show the thought process">
          {part.text ? <div className="border-l border-line pl-3 text-sm text-muted"><Markdown>{part.text}</Markdown></div> : undefined}
        </TraceStep> : null
        : <CallStep key={part.callId} part={part} childTitles={childTitles} readOnly={readOnly} />)}
    </TraceList>
  </TraceLine>;
}

/** One call as a step that opens into its full card. */
function CallStep({ part, childTitles, single = false, readOnly = false }: { part: ToolCallPart; childTitles: ReadonlyMap<string, string>; single?: boolean; readOnly?: boolean }) {
  const view = stepView(part, childTitles);
  const Line = single ? TraceLine : TraceStep;
  return <Line icon={view.status === "error" ? <AlertCircle /> : view.icon} title={view.title} detail={view.detail} status={view.status}
    defaultOpen={getToolCardDefault() === "always-expanded"}>
    <ToolCallBlock part={part} readOnly={readOnly} />
  </Line>;
}
