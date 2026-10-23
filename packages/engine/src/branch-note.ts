/**
 * Branch notes (docs/specs/2026-10-22-thread-edit-fork-design.md). An edit,
 * a return to an earlier version, and a fork each write one
 * `branch_summary` entry. Its `summary` is the text the model reads, and
 * `metadata.branchNote` holds the same facts for the UI. The engine builds
 * both from the records on the branch the thread left (tool calls, approval
 * choices, file checkpoints), with no model call.
 */
import { WORKSPACE_FILES } from "./checkpoints.js";
import type { SessionEntry } from "./types.js";

/** Entry metadata key for the UI's copy of a note's facts. */
export const BRANCH_NOTE_KEY = "branchNote";

/** Queue item metadata key that makes the item an edit of an earlier message. */
export const THREAD_EDIT_KEY = "threadEdit";

/** The most action lines one note lists. The rest collapse into a count. */
const MAX_NOTE_ACTIONS = 12;
/** The most file names one note's text names. */
const MAX_NOTE_FILES = 10;
/** Approval actions the engine offers itself. A host's extra approving action is a grant that outlives the turn. */
const ONE_TIME_APPROVALS = new Set(["approve"]);

export type BranchNoteKind = "edit" | "return" | "fork";

/** One line of what ran: a plugin action call, or a built-in tool with a count. */
export interface BranchNoteAction {
  tool: string;
  label: string;
  count: number;
  /** Links the tool reported for confirmed side effects, such as a pull request. */
  urls: string[];
}

/** What a file undo or restore did in one repository. */
export interface BranchNoteRepoFiles {
  repo: string;
  restored: string[];
  removed: string[];
  /** Paths left alone because their content changed after the turns being undone. */
  skipped: string[];
  failed?: string;
  /** The snapshot taken before the change, so a return can bring the files back. */
  restorePoint?: string;
  /** The content each restored or removed path returned to, by commit. */
  bases?: Record<string, string>;
}

export interface BranchNote {
  kind: BranchNoteKind;
  /** The first typed message on the version this note left. */
  version?: { excerpt: string; createdAt: number };
  actions: BranchNoteAction[];
  /** Calls past `MAX_NOTE_ACTIONS` lines. */
  moreActions: number;
  /** A tool that can change the working directory ran on the left branch. */
  filesChanged: boolean;
  /** Approval choices on the left branch that still apply, such as "Always allow for me". */
  grants: string[];
  /** File changes put back when the leaf moved. */
  files?: BranchNoteRepoFiles[];
  /** The person whose action wrote the note. */
  actorId?: string;
  /** Fork notes only: the thread the history came from. */
  source?: { sessionId: string; threadId: string; sameWorkingDirectory: boolean };
  /** Fork notes only: repositories whose files come to the new working directory before the first turn. */
  seed?: ForkSeedRecord[];
  /** Fork notes only: why no files come along. */
  seedSkipped?: string;
  /** Fork notes only: what the first turn's file copy did. */
  seedResult?: Array<{ repo: string; paths: string[]; failed?: string }>;
}

/** A fork seed: one repository's snapshot, stored as a git bundle in the blob store. */
export interface ForkSeedRecord {
  /** The repository's path relative to the working directory, the same in both threads. */
  repo: string;
  snapshot: string;
  branch?: string;
  blobKey: string;
}

export interface ThreadEdit {
  /** The user message the edit replaces. */
  entryId: string;
  /** Also put back the files the replaced turns changed. */
  undoFiles?: boolean;
}

/** What an edit would replace, for the edit bar before Send (`Thread.previewEdit`). */
export interface EditPreview {
  /** Why the edit is refused, when it is. */
  refusal?: string;
  /** Typed messages the edit replaces: the edited one and the later ones. */
  turns: number;
  actions: BranchNoteAction[];
  moreActions: number;
  grants: string[];
  /** Files the replaced turns changed, which the edit can also undo. */
  files: Array<{ repo: string; path: string }>;
  /** The replaced turns pushed commits or opened a pull request, which a file undo does not reach. */
  pushed: boolean;
}

/** A replaced turn ran `git push` or opened a pull request. */
export function pushedFrom(entries: readonly SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call" || part.status !== "completed") continue;
      const args = isRecord(part.args) ? part.args : {};
      if (typeof args.command === "string" && /\bgit\s+push\b/.test(args.command)) return true;
      const holder = resultDetails(part.result);
      if (holder && "outcome" in holder && isRecord(holder.outcome) && holder.outcome.kind === "pull_request_created") return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readThreadEdit(metadata: Record<string, unknown> | undefined): ThreadEdit | undefined {
  const value = metadata?.[THREAD_EDIT_KEY];
  if (!isRecord(value) || typeof value.entryId !== "string") return undefined;
  return { entryId: value.entryId, ...(value.undoFiles === true ? { undoFiles: true } : {}) };
}

export function readBranchNote(metadata: Record<string, unknown> | undefined): BranchNote | undefined {
  const v = metadata?.[BRANCH_NOTE_KEY];
  if (!isRecord(v)) return undefined;
  if (v.kind !== "edit" && v.kind !== "return" && v.kind !== "fork") return undefined;
  const actions = Array.isArray(v.actions) ? v.actions.flatMap(readAction) : [];
  const source = readSource(v.source);
  const files = Array.isArray(v.files) ? v.files.flatMap(readRepoFiles) : undefined;
  const seed = Array.isArray(v.seed) ? v.seed.flatMap(readSeed) : undefined;
  const seedResult = Array.isArray(v.seedResult) ? v.seedResult.flatMap(readSeedResult) : undefined;
  return {
    kind: v.kind,
    ...(isRecord(v.version) && typeof v.version.excerpt === "string" && typeof v.version.createdAt === "number"
      && Number.isFinite(v.version.createdAt)
      ? { version: { excerpt: v.version.excerpt.slice(0, 180), createdAt: v.version.createdAt } } : {}),
    actions,
    moreActions: typeof v.moreActions === "number" ? v.moreActions : 0,
    filesChanged: v.filesChanged === true,
    grants: strings(v.grants),
    ...(files && files.length > 0 ? { files } : {}),
    ...(typeof v.actorId === "string" ? { actorId: v.actorId } : {}),
    ...(source ? { source } : {}),
    ...(seed && seed.length > 0 ? { seed } : {}),
    ...(typeof v.seedSkipped === "string" ? { seedSkipped: v.seedSkipped } : {}),
    ...(seedResult ? { seedResult } : {}),
  };
}

function readAction(v: unknown): BranchNoteAction[] {
  if (!isRecord(v)) return [];
  if (typeof v.tool !== "string" || typeof v.label !== "string" || typeof v.count !== "number") return [];
  return [{ tool: v.tool, label: v.label, count: v.count, urls: strings(v.urls) }];
}

function readRepoFiles(v: unknown): BranchNoteRepoFiles[] {
  if (!isRecord(v) || typeof v.repo !== "string") return [];
  const bases = isRecord(v.bases)
    ? Object.fromEntries(Object.entries(v.bases).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
    : undefined;
  return [{
    repo: v.repo,
    restored: strings(v.restored),
    removed: strings(v.removed),
    skipped: strings(v.skipped),
    ...(typeof v.failed === "string" ? { failed: v.failed } : {}),
    ...(typeof v.restorePoint === "string" ? { restorePoint: v.restorePoint } : {}),
    ...(bases ? { bases } : {}),
  }];
}

function readSeed(v: unknown): ForkSeedRecord[] {
  if (!isRecord(v) || typeof v.repo !== "string" || typeof v.snapshot !== "string" || typeof v.blobKey !== "string") return [];
  return [{ repo: v.repo, snapshot: v.snapshot, blobKey: v.blobKey, ...(typeof v.branch === "string" ? { branch: v.branch } : {}) }];
}

function readSeedResult(v: unknown): Array<{ repo: string; paths: string[]; failed?: string }> {
  if (!isRecord(v) || typeof v.repo !== "string") return [];
  return [{ repo: v.repo, paths: strings(v.paths), ...(typeof v.failed === "string" ? { failed: v.failed } : {}) }];
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
 * one line with a count, per `path` argument when the call has one. A call to
 * a tool in `tools.files` means the working directory may have changed.
 * Grants are approval choices a host offered beyond the engine's one-time
 * approval, such as "Always allow for me": they outlive the branch.
 */
export function summarizeBranchActions(
  entries: readonly SessionEntry[],
  tools: { silent: ReadonlySet<string>; files: ReadonlySet<string>; plugin: ReadonlySet<string> },
): Pick<BranchNote, "actions" | "moreActions" | "filesChanged" | "grants"> {
  const lines: BranchNoteAction[] = [];
  const builtin = new Map<string, BranchNoteAction>();
  const grants: string[] = [];
  let filesChanged = false;
  for (const entry of entries) {
    if (entry.type === "decision_gate") {
      const grant = grantOf(entry);
      if (grant && !grants.includes(grant)) grants.push(grant);
      continue;
    }
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
  return { actions: shown, moreActions, filesChanged, grants };
}

/** "Always allow for me: Create a pull request" for a gate answered with a lasting approval. */
function grantOf(entry: Extract<SessionEntry, { type: "decision_gate" }>): string | undefined {
  const actionId = entry.resolution?.actionId;
  if (!actionId || ONE_TIME_APPROVALS.has(actionId)) return undefined;
  const action = entry.gate.actions.find((candidate) => candidate.id === actionId);
  if (!action?.approves) return undefined;
  return `${action.label}: ${entry.gate.title}`;
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

function nameFiles(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_NOTE_FILES).join(", ");
  return paths.length > MAX_NOTE_FILES ? `${shown}, and ${paths.length - MAX_NOTE_FILES} more` : shown;
}

/** Sentences about a file undo or restore, for the model. */
function repoLabel(repo: string): string {
  return repo === WORKSPACE_FILES ? "Working directory" : repo;
}

function filesText(files: readonly BranchNoteRepoFiles[], verb: string, left: string): string[] {
  const lines: string[] = [];
  const changed = files.flatMap((repo) => [...repo.restored, ...repo.removed]);
  const skipped = files.flatMap((repo) => repo.skipped);
  if (changed.length > 0) lines.push(`File changes were ${verb}: ${nameFiles(changed)}.`);
  if (skipped.length > 0) lines.push(`These files changed after ${left}, so they were left as they are: ${nameFiles(skipped)}.`);
  for (const repo of files) {
    if (repo.failed) lines.push(`In ${repoLabel(repo.repo)}, the file change failed (${repo.failed}), so its files are as ${left} left them.`);
  }
  if (files.length > 0) lines.push("File restore covers checkpointed paths only. Hidden files, dependencies, caches, secrets and files outside the working directory are not covered by working-directory checkpoints.");
  return lines;
}

/** The note text the model reads, inside a `<branch-note>` block. */
export function branchNoteText(note: BranchNote): string {
  if (note.kind === "fork") {
    const lines = [
      "This thread is a branch of another thread. The history above is a copy, and the original thread continues on its own.",
      "Everything in the copied history already ran and still stands.",
    ];
    if (note.source?.sameWorkingDirectory) {
      lines.push("This thread shares its working directory with the original thread, including changes made there after the branch point.");
    } else if (note.seedResult) {
      const copied = note.seedResult.filter((repo) => !repo.failed);
      if (copied.length > 0) lines.push(`This thread has its own working directory. Files from the original thread at the branch point were copied into ${copied.map((repo) => repoLabel(repo.repo)).join(", ")}.`);
      for (const repo of note.seedResult) {
        if (repo.failed) lines.push(`Files for ${repoLabel(repo.repo)} could not be copied: ${repo.failed}.`);
      }
    } else if (note.seed) {
      lines.push(`This thread has its own working directory. Files from the original thread at the branch point are copied into ${note.seed.map((repo) => repoLabel(repo.repo)).join(", ")} before the first turn.`);
    } else {
      lines.push(`This thread has its own working directory, so files from the original thread are not here${note.seedSkipped ? ` (${note.seedSkipped})` : ""}.`);
    }
    return lines.join("\n");
  }
  const opening = note.kind === "edit"
    ? "The person edited an earlier message, so the conversation continues from before that message. The earlier version is kept, but it is no longer part of this conversation."
    : "The person went back to an earlier version of this conversation. The version they left is kept, but it is no longer part of this conversation.";
  const left = note.kind === "edit" ? "the earlier version" : "the version they left";
  const lines = [opening];
  if (note.actions.length === 0) {
    lines.push(`No tools changed anything in ${left}.`);
  } else {
    lines.push(`Nothing that ran in ${left} was undone${note.files ? " outside the working directory" : ""}. These calls ran there and still stand:`);
    for (const action of note.actions) {
      const count = action.count > 1 ? `, ${action.count} calls` : "";
      const urls = action.urls.length > 0 ? ` (${action.urls.join(", ")})` : "";
      lines.push(`- ${action.label}${count}${urls}`);
    }
    if (note.moreActions > 0) lines.push(`- ${note.moreActions} more calls`);
    lines.push("Before you repeat one of these actions, check whether its result already exists.");
  }
  if (note.grants.length > 0) {
    lines.push(`Approval choices made in ${left} still apply: ${note.grants.join("; ")}.`);
  }
  if (note.files) {
    lines.push(...filesText(note.files, note.kind === "edit" ? `undone to their state before ${left}` : "brought back from the version this one returned to", left));
  } else if (note.filesChanged) {
    lines.push(`The working directory keeps any file changes from ${left}.`);
  }
  return lines.join("\n");
}
