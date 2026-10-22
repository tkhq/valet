/**
 * Branch notes (docs/specs/2026-10-22-thread-edit-fork-design.md). An edit,
 * a return to an earlier version, and a fork each write one
 * `branch_summary` entry. Its `summary` is the text the model reads, and
 * `metadata.branchNote` holds the same facts for the UI. The engine builds
 * both from the tool calls on the branch the thread left, with no model call.
 */
import type { SessionEntry } from "./types.js";

/** Entry metadata key for the UI's copy of a note's facts. */
export const BRANCH_NOTE_KEY = "branchNote";

/** Queue item metadata key that makes the item an edit of an earlier message. */
export const THREAD_EDIT_KEY = "threadEdit";

/** The most action lines one note lists. The rest collapse into a count. */
const MAX_NOTE_ACTIONS = 12;

export type BranchNoteKind = "edit" | "return" | "fork";

/** One line of what ran: a plugin action call, or a built-in tool with a count. */
export interface BranchNoteAction {
  tool: string;
  label: string;
  count: number;
  /** Links the tool reported for confirmed side effects, such as a pull request. */
  urls: string[];
}

export interface BranchNote {
  kind: BranchNoteKind;
  actions: BranchNoteAction[];
  /** Calls past `MAX_NOTE_ACTIONS` lines. */
  moreActions: number;
  /** A tool that can change the working directory ran on the left branch. */
  filesChanged: boolean;
  /** The person whose action wrote the note. */
  actorId?: string;
  /** Fork notes only: the thread the history came from. */
  source?: { sessionId: string; threadId: string; sameWorkingDirectory: boolean };
}

export interface ThreadEdit {
  /** The user message the edit replaces. */
  entryId: string;
}

export function readThreadEdit(metadata: Record<string, unknown> | undefined): ThreadEdit | undefined {
  const value = metadata?.[THREAD_EDIT_KEY];
  if (typeof value !== "object" || value === null || !("entryId" in value)) return undefined;
  return typeof value.entryId === "string" ? { entryId: value.entryId } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBranchNote(metadata: Record<string, unknown> | undefined): BranchNote | undefined {
  const v = metadata?.[BRANCH_NOTE_KEY];
  if (!isRecord(v)) return undefined;
  if (v.kind !== "edit" && v.kind !== "return" && v.kind !== "fork") return undefined;
  const actions = Array.isArray(v.actions) ? v.actions.flatMap(readAction) : [];
  const source = readSource(v.source);
  return {
    kind: v.kind,
    actions,
    moreActions: typeof v.moreActions === "number" ? v.moreActions : 0,
    filesChanged: v.filesChanged === true,
    ...(typeof v.actorId === "string" ? { actorId: v.actorId } : {}),
    ...(source ? { source } : {}),
  };
}

function readAction(v: unknown): BranchNoteAction[] {
  if (!isRecord(v)) return [];
  if (typeof v.tool !== "string" || typeof v.label !== "string" || typeof v.count !== "number") return [];
  const urls = Array.isArray(v.urls) ? v.urls.filter((url): url is string => typeof url === "string") : [];
  return [{ tool: v.tool, label: v.label, count: v.count, urls }];
}

function readSource(v: unknown): BranchNote["source"] {
  if (!isRecord(v)) return undefined;
  if (typeof v.sessionId !== "string" || typeof v.threadId !== "string") return undefined;
  return { sessionId: v.sessionId, threadId: v.threadId, sameWorkingDirectory: v.sameWorkingDirectory === true };
}

/**
 * What ran on a branch: every completed tool call except tools that leave
 * nothing outside the conversation (`tools.silent`) and calls that reported
 * failure. A plugin action call (`tools.plugin`) gets its own line,
 * labelled by its `summary` argument or its `tool_id`. Any other tool gets
 * one line with a count, per `path` argument when the call has one. A call to a tool in `tools.files` means the working
 * directory may have changed.
 */
export function summarizeBranchActions(
  entries: readonly SessionEntry[],
  tools: { silent: ReadonlySet<string>; files: ReadonlySet<string>; plugin: ReadonlySet<string> },
): Pick<BranchNote, "actions" | "moreActions" | "filesChanged"> {
  const lines: BranchNoteAction[] = [];
  const builtin = new Map<string, BranchNoteAction>();
  let filesChanged = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call" || part.status !== "completed") continue;
      if (tools.silent.has(part.toolName) || reportedFailure(part.result)) continue;
      const urls = outcomeUrls(part.result);
      const args = isRecord(part.args) ? part.args : {};
      const toolId = typeof args.tool_id === "string" ? args.tool_id : undefined;
      if (toolId !== undefined || tools.plugin.has(part.toolName)) {
        const summary = typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : undefined;
        const name = toolId ?? part.toolName;
        lines.push({ tool: name, label: summary ? `${name}: ${summary}` : name, count: 1, urls });
        continue;
      }
      if (tools.files.has(part.toolName)) filesChanged = true;
      // A call on a path (a file write, a memory note) names the path; calls
      // to the same tool on the same path, or with no path, share a line.
      const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
      const key = path ? `${part.toolName} ${path}` : part.toolName;
      const line = builtin.get(key);
      if (line) {
        line.count += 1;
        line.urls.push(...urls);
      } else {
        const fresh = { tool: part.toolName, label: key, count: 1, urls };
        builtin.set(key, fresh);
        lines.push(fresh);
      }
    }
  }
  const shown = lines.slice(0, MAX_NOTE_ACTIONS);
  const moreActions = lines.slice(MAX_NOTE_ACTIONS).reduce((total, line) => total + line.count, 0);
  return { actions: shown, moreActions, filesChanged };
}

/**
 * The object that carries `ok` and `outcome`. A persisted result has
 * pi-agent-core's shape, where the tool bridge puts both in `details`; an
 * engine `ToolResult` carries them at the top level.
 */
function resultDetails(result: unknown): object | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return "details" in result && typeof result.details === "object" && result.details !== null
    ? result.details
    : result;
}

/** A call that completed but whose result says the action failed (`ok: false`). */
function reportedFailure(result: unknown): boolean {
  const details = resultDetails(result);
  return details !== undefined && "ok" in details && details.ok === false;
}

function outcomeUrls(result: unknown): string[] {
  const holder = resultDetails(result);
  if (!holder || !("outcome" in holder)) return [];
  const outcome = holder.outcome;
  if (typeof outcome !== "object" || outcome === null || !("url" in outcome)) return [];
  return typeof outcome.url === "string" ? [outcome.url] : [];
}

/** The note text the model reads, inside a `<branch-note>` block. */
export function branchNoteText(note: BranchNote): string {
  if (note.kind === "fork") {
    const files = note.source?.sameWorkingDirectory
      ? "This thread shares its working directory with the original thread."
      : "This thread has its own working directory, so files from the original thread are not here.";
    return [
      "This thread is a branch of another thread. The history above is a copy, and the original thread continues on its own.",
      "Everything in the copied history already ran and still stands.",
      files,
    ].join("\n");
  }
  const opening = note.kind === "edit"
    ? "The person edited an earlier message, so the conversation continues from before that message. The earlier version is kept, but it is no longer part of this conversation."
    : "The person went back to an earlier version of this conversation. The version they left is kept, but it is no longer part of this conversation.";
  const left = note.kind === "edit" ? "the earlier version" : "the version they left";
  const lines = [opening];
  if (note.actions.length === 0) {
    lines.push(`No tools changed anything in ${left}.`);
  } else {
    lines.push(`Nothing that ran in ${left} was undone. These calls ran there and still stand:`);
    for (const action of note.actions) {
      const count = action.count > 1 ? `, ${action.count} calls` : "";
      const urls = action.urls.length > 0 ? ` (${action.urls.join(", ")})` : "";
      lines.push(`- ${action.label}${count}${urls}`);
    }
    if (note.moreActions > 0) lines.push(`- ${note.moreActions} more calls`);
    lines.push("Before you repeat one of these actions, check whether its result already exists.");
  }
  if (note.filesChanged) lines.push(`The working directory keeps any file changes from ${left}.`);
  return lines.join("\n");
}
