import { readThreadPlan, readTurnPlans, type ThreadPlan, type ProgressStatus, type ProgressTask, type TurnProgress } from "@valet/shared";
import { RECORD_ONLY_KEY, type DecisionGate, type QueueItem, type SessionEntry, type SessionStore } from "./types.js";

const MAX_TASKS = 20;
const ENTRY_TAIL_LIMIT = 64;
const TOOL_LABELS: Record<string, string> = {
  exec: "Run command", bash: "Run command", read: "Read file", read_file: "Read file",
  write: "Write file", write_file: "Write file", edit: "Edit file", edit_file: "Edit file",
  apply_patch: "Edit files", search: "Search", web_search: "Search the web", call_tool: "Run tool",
  ask_question: "Ask a question", request_approval: "Request approval",
};

// Exact IDs only. Dynamic catalog names and action parameters are not public labels.
const ACTION_LABEL_GROUPS: ReadonlyArray<{ label: string; ids: readonly string[] }> = [
  { label: "Search Slack", ids: ["slack.search_channels", "slack_user.search_messages"] },
  { label: "Read Slack", ids: ["slack.read_history", "slack.read_thread", "slack.list_channels", "slack.list_users", "slack.get_pins", "slack.get_channel_info", "slack.get_reactions", "slack.fetch_file", "slack.lookup_user_by_email", "slack_user.list_channels", "slack_user.read_history", "slack_user.read_thread", "slack_user.get_status"] },
  { label: "Update Slack", ids: ["slack.send_message", "slack.update_message", "slack.delete_message", "slack.add_reaction", "slack.dm_owner", "slack.dm_user", "slack.reply_to_origin", "slack.reply_file_to_origin", "slack.react_to_origin", "slack.join_channel", "slack_user.post_message", "slack_user.send_dm", "slack_user.add_reaction", "slack_user.upload_file", "slack_user.set_status", "slack_user.set_dnd", "slack_user.end_dnd", "slack_user.add_pin", "slack_user.add_bookmark", "slack_user.add_reminder"] },
  { label: "Search GitHub", ids: ["github.search_code", "github.search_issues"] },
  { label: "Read GitHub", ids: ["github.get_repository", "github.list_repos", "github.get_issue", "github.get_pull_request", "github.list_pull_requests", "github.inspect_pull_request", "github.list_issues", "github.list_commits", "github.list_workflow_runs", "github.get_workflow_run", "github.get_job_logs", "github.list_workflows", "github.read_repo_file", "github.list_repo_directory"] },
  { label: "Update GitHub", ids: ["github.create_issue", "github.create_comment", "github.create_review", "github.request_reviewers", "github.update_pull_request", "github.create_repository", "github.update_issue", "github.create_pull_request", "github.merge_pull_request", "github.create_branch", "github.delete_branch", "github.create_release", "github.fork_repository", "github.rerun_workflow", "github.cancel_workflow_run", "github.trigger_workflow"] },
  { label: "Read Linear", ids: ["linear.get_issue", "linear.list_issues", "linear.get_project", "linear.list_projects", "linear.list_teams", "linear.get_team", "linear.list_comments", "linear.list_cycles", "linear.list_issue_statuses", "linear.list_issue_labels", "linear.list_users", "linear.get_user"] },
  { label: "Search Linear", ids: ["linear.search_issues"] },
  { label: "Update Linear", ids: ["linear.update_issue", "linear.create_issue", "linear.save_issue", "linear.create_comment", "linear.update_comment", "linear.create_project", "linear.update_project", "linear.save_project"] },
];
const ACTION_LABELS = new Map(ACTION_LABEL_GROUPS.flatMap(({ label, ids }) => ids.map((id) => [id, label] as const)));

function toolLabel(toolName: string, args: unknown): string {
  if (toolName === "call_tool") {
    if (typeof args !== "object" || args === null || Array.isArray(args) || !("tool_id" in args) || typeof args.tool_id !== "string") return "Run tool";
    return ACTION_LABELS.get(args.tool_id) ?? "Run tool";
  }
  return Object.hasOwn(TOOL_LABELS, toolName) ? (TOOL_LABELS[toolName] ?? "Run tool") : "Run tool";
}

function visibleTasks(tasks: ProgressTask[], planIds: Set<string>): ProgressTask[] {
  const priority = (task: ProgressTask): number => task.status === "waiting" ? 4 : task.status === "in_progress" ? 3 : task.status === "error" ? 2 : planIds.has(task.id) ? 1 : 0;
  const ranked = tasks.map((task, index) => ({ task, index })).sort((a, b) =>
    priority(b.task) - priority(a.task) ||
    Number(planIds.has(b.task.id)) - Number(planIds.has(a.task.id)) ||
    (planIds.has(a.task.id) ? a.index - b.index : b.index - a.index),
  );
  const selected = new Set(ranked.slice(0, MAX_TASKS).map(({ task }) => task.id));
  // Keep plan order and tool chronology after selecting the tasks that need attention.
  return tasks.filter((task) => selected.has(task.id));
}

/** A portable change token. This fingerprint is not a security hash. */
function progressRevision(text: string): string {
  let first = 0x811c9dc5;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second, 33) ^ code;
  }
  return `p1:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}:${text.length.toString(36)}`;
}

function failedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("ok" in result && result.ok === false) return true;
  if (!("details" in result) || typeof result.details !== "object" || result.details === null) return false;
  return "ok" in result.details && result.details.ok === false;
}

/** Project public progress from durable facts. Never copy tool input or output. */
export function projectTurnProgress(
  item: QueueItem,
  entries: readonly SessionEntry[],
  gates: readonly DecisionGate[],
  plan?: ThreadPlan,
): TurnProgress | null {
  if (item.metadata?.[RECORD_ONLY_KEY] === true) return null;
  const interrupted = item.outcome?.outcome === "aborted" || item.outcome?.outcome === "superseded" || item.outcome?.outcome === "merged";
  const terminal = item.status === "settled";
  const waiting = !terminal && gates.some((gate) => gate.queueItemId === item.id && gate.status === "pending");
  const status: ProgressStatus = interrupted ? "interrupted" : item.outcome?.outcome === "failed" ? "error" : terminal ? "complete" : waiting || item.status === "blocked_on_decision_gate" ? "waiting" : item.status === "queued" || item.status === "collecting" ? "pending" : "in_progress";
  const tasks = new Map<string, ProgressTask>();
  const validPlan = readThreadPlan({ plan });
  const turnPlan = validPlan?.turnId === item.id ? validPlan : undefined;
  for (const [index, step] of (turnPlan?.items ?? []).entries()) {
    const id = step.id ?? `plan:${item.id}:${index}`;
    tasks.set(id, { id, title: step.text, status: step.status === "done" ? "complete" : interrupted ? "interrupted" : step.status === "in_progress" && (status === "waiting" || status === "error") ? status : step.status });
  }
  const planIds = new Set(tasks.keys());
  let updatedAt = Math.max(item.updatedAt, turnPlan?.updatedAt ?? 0);
  for (const entry of entries) {
    if (entry.queueItemId !== item.id) continue;
    updatedAt = Math.max(updatedAt, entry.createdAt);
    if (turnPlan || entry.type !== "message") continue;
    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call" || part.toolName === "update_plan") continue;
      const failed = part.status === "error" || failedResult(part.result);
      const taskStatus: ProgressStatus = failed ? "error" : part.status === "completed" ? "complete" : interrupted ? "interrupted" : waiting ? "waiting" : terminal ? "interrupted" : "in_progress";
      const id = `tool:${part.callId}`;
      tasks.set(id, { id, title: toolLabel(part.toolName, part.args), status: taskStatus });
    }
  }
  for (const gate of gates) {
    if (gate.queueItemId !== item.id) continue;
    updatedAt = Math.max(updatedAt, gate.updatedAt);
    if (turnPlan || gate.status !== "pending" || terminal) continue;
    const id = `gate:${gate.id}`;
    tasks.set(id, { id, title: gate.type === "approval" ? "Approval required" : "Response required", status: "waiting" });
  }
  const allTasks = [...tasks.values()];
  const snapshot = { turnId: item.id, title: turnPlan?.title ?? "Task progress", status, updatedAt, tasks: visibleTasks(allTasks, planIds), omittedTasks: Math.max(0, allTasks.length - MAX_TASKS) };
  return { ...snapshot, revision: progressRevision(JSON.stringify({ ...snapshot, allTasks })) };
}

export async function readTurnProgress(store: SessionStore, sessionId: string, threadId: string, turnId: string): Promise<TurnProgress | null> {
  const [thread, item] = await Promise.all([store.getThread(sessionId, threadId), store.getQueueItem(sessionId, turnId)]);
  if (!thread || !item || item.threadId !== threadId || item.metadata?.[RECORD_ONLY_KEY] === true) return null;
  const [entries, gates] = await Promise.all([
    store.getEntries(sessionId, threadId, { queueItemId: turnId, includeCompacted: true, includeSystemEntries: true }),
    store.listDecisionGatesForQueueItem(sessionId, threadId, turnId),
  ]);
  const current = readThreadPlan(thread.metadata);
  const plan = current?.turnId === turnId ? current : readTurnPlans(thread.metadata).find((candidate) => candidate.turnId === turnId);
  return projectTurnProgress(item, entries, gates, plan);
}

export async function readLatestTurnProgress(store: SessionStore, sessionId: string, threadId: string): Promise<TurnProgress | null> {
  const thread = await store.getThread(sessionId, threadId);
  if (!thread) return null;
  const unsettled = await store.listUnsettledSubmissions(sessionId);
  const active = unsettled.filter((item) => item.threadId === threadId && !item.supersededByItemId && !item.mergedIntoItemId && item.metadata?.[RECORD_ONLY_KEY] !== true);
  active.sort((a, b) => {
    const rank = (item: QueueItem) => item.status === "running" || item.status === "blocked_on_decision_gate" || item.status === "terminalizing" ? 1 : 0;
    return rank(b) - rank(a) || b.createdAt - a.createdAt;
  });
  if (active[0]) return readTurnProgress(store, sessionId, threadId, active[0].id);
  const entries = await store.getEntries(sessionId, threadId, { limit: ENTRY_TAIL_LIMIT, includeCompacted: true, includeSystemEntries: true });
  if (!thread.activeLeafEntryId) {
    const seenTurns = new Set<string>();
    const readLegacy = async (candidates: readonly SessionEntry[]): Promise<TurnProgress | null> => {
      for (const entry of [...candidates].reverse()) {
        if (!entry.queueItemId || seenTurns.has(entry.queueItemId)) continue;
        seenTurns.add(entry.queueItemId);
        const progress = await readTurnProgress(store, sessionId, threadId, entry.queueItemId);
        if (progress) return progress;
      }
      return null;
    };
    const progress = await readLegacy(entries);
    if (progress || entries.length < ENTRY_TAIL_LIMIT) return progress;
    const snapshot = await store.getThreadSnapshot(sessionId, threadId);
    return snapshot ? readLegacy(snapshot.entries) : null;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let cursor: string | undefined = thread.activeLeafEntryId;
  const visited = new Set<string>();
  const seenTurns = new Set<string>();
  let loadedSnapshot = false;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    let entry = byId.get(cursor);
    if (!entry && !loadedSnapshot) {
      // Older branch points can fall outside the tail. Use the store's coherent snapshot only then.
      const snapshot = await store.getThreadSnapshot(sessionId, threadId);
      loadedSnapshot = true;
      for (const ancestor of snapshot?.entries ?? []) byId.set(ancestor.id, ancestor);
      entry = byId.get(cursor);
    }
    if (!entry) break;
    if (entry.queueItemId && !seenTurns.has(entry.queueItemId)) {
      seenTurns.add(entry.queueItemId);
      const progress = await readTurnProgress(store, sessionId, threadId, entry.queueItemId);
      if (progress) return progress;
    }
    cursor = entry.parentId ?? undefined;
  }
  return null;
}
