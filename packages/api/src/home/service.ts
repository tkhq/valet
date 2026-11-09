/**
 * Home: one ongoing conversation between a person and Valet that spans every
 * workspace they can work in. It lives in the person's personal assistant
 * session under the thread key `home`. From it, Valet starts work threads in
 * any of the person's workspaces (`startHomeTask`), and `listHomeTasks`
 * gathers what is in flight and what needs the person across all of them.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { EventStream, Principal, QueueItem, Session, SessionStore, Thread } from "@valet/engine";
import { planProgress, readThreadPlan } from "@valet/shared";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { homeTaskDismissals, homeTasks, sessionThreads, users } from "../schema/index.js";
import { isTeamMember, listTeamsForUser } from "../services/teams.js";
import { visibleThreadIds, type AccessDeps } from "../services/thread-access.js";
import { listWaitingThreads } from "../services/thread-read-state.js";
import { listWorkspaceActiveWork } from "../services/workspace-active-work.js";
import { recordThreadUserActivity } from "../services/thread-activity.js";
import { activeViewers, type ActiveViewers } from "../services/active-viewers.js";
import type { HomeTaskItem, HomeTaskOutput, HomeTasksResponse, HomeWorkspaceRef } from "../wire/types.js";

import { HOME_TASK_GIT_NOTE, HOME_THREAD_KEY } from "./context.js";

export { HOME_THREAD_KEY };

/** Visibility checks need credential reads (a private Slack channel's members). */
export interface HomeDeps extends AccessDeps {
  engineHost: EngineHost;
  engineStore: SessionStore;
}

/** Submission metadata that marks a message sent by the home tools, so its
 * settlement reports back to home. */
export const HOME_TASK_REPORT_KEY = "homeTaskReport";

export interface HomeUser {
  id: string;
  orgId: string;
}

export interface HomeWorkspace extends HomeWorkspaceRef {
  owner: Principal;
}

type HomeTask = typeof homeTasks.$inferSelect;

/** A saved task is a pointer, not a grant to its thread's current audience. */
async function canAccessTask(deps: HomeDeps, user: HomeUser, row: HomeTask): Promise<boolean> {
  if (row.ownerType === "user") return row.ownerId === user.id;
  if (row.ownerType !== "team" || !await isTeamMember(deps.db, row.ownerId, user.id)) return false;
  const shown = await visibleThreadIds(deps, { ownerType: row.ownerType }, { orgId: user.orgId, userId: user.id }, [row]);
  return shown.has(`${row.sessionId}:${row.threadId}`);
}

/** At most fifty started tasks; check their current audience before enrichment. */
async function visibleStartedTasks(deps: HomeDeps, user: HomeUser, workspaces: HomeWorkspace[]): Promise<HomeTask[]> {
  const rows = await deps.db.select().from(homeTasks)
    .where(and(eq(homeTasks.userId, user.id), eq(homeTasks.orgId, user.orgId), isNull(homeTasks.doneAt)))
    .orderBy(desc(homeTasks.createdAt)).limit(50);
  const groups = await Promise.all(workspaces.map(async (ws) => {
    const owned = rows.filter((row) => row.ownerType === ws.owner.type && row.ownerId === ws.owner.id);
    const shown = await visibleThreadIds(deps, { ownerType: ws.owner.type }, { orgId: user.orgId, userId: user.id }, owned);
    return owned.filter((row) => shown.has(`${row.sessionId}:${row.threadId}`));
  }));
  return groups.flat();
}

/** A workspace's first page can omit a busy task. Read all saved tasks' live
 * states in one query, with at most one row per visible task. */
async function startedTaskActivity(db: AppDb, user: HomeUser, started: HomeTask[]) {
  if (started.length === 0) return [];
  const pairs = sql.join(started.map((row) => sql`(${row.sessionId},${row.threadId})`), sql`, `);
  const result = await db.execute(sql`SELECT q.session_id,q.thread_id,MAX(q.updated_at) AS updated_at,
      CASE WHEN bool_or(q.status='blocked_on_decision_gate') THEN 'needs_you'
        WHEN bool_or(q.outcome='failed') THEN 'failed' ELSE 'working' END AS state
    FROM engine_queue_items q JOIN agent_sessions s ON s.id=q.session_id
    WHERE s.org_id=${user.orgId} AND s.status<>'deleted'
      AND (q.session_id,q.thread_id) IN (${pairs}) AND q.status<>'settled'
      AND (q.status IN ('blocked_on_decision_gate','collecting','queued','running') OR q.outcome='failed')
    GROUP BY q.session_id,q.thread_id`) as { rows: Array<{ session_id: string; thread_id: string; updated_at: string | number; state: "needs_you" | "failed" | "working" }> };
  return result.rows.map((row) => ({ id: `started:${row.session_id}:${row.thread_id}`, sessionId: row.session_id,
    threadId: row.thread_id, updatedAt: Number(row.updated_at), state: row.state }));
}

/** The person's home thread, created on first use. */
export async function ensureHomeThread(deps: HomeDeps, user: HomeUser): Promise<{ session: Session; thread: Thread }> {
  const { session } = await ensureDefaultAssistantSession(deps, { type: "user", id: user.id }, { actorUserId: user.id, orgId: user.orgId });
  const data = await session.toData();
  const thread = await deps.engineHost.ensureFreshThread(session, HOME_THREAD_KEY,
    { userId: data.userId, orgId: data.orgId, workspace: data.workspace }, user.id, { title: "Home" });
  await thread.setMode("followup");
  return { session, thread };
}

/** Every workspace the person can work in: personal first, then their teams in this org. */
export async function homeWorkspaces(db: AppDb, user: HomeUser): Promise<HomeWorkspace[]> {
  const teams = (await listTeamsForUser(db, user.id)).filter((team) => team.orgId === user.orgId);
  return [
    { key: "user", name: "Personal", owner: { type: "user", id: user.id } },
    ...teams.map((team): HomeWorkspace => ({ key: team.id, name: team.name, owner: { type: "team", id: team.id } })),
  ];
}

/** Finds a workspace by key, team id, or name (case and spacing ignored). */
export function matchWorkspace(workspaces: readonly HomeWorkspace[], input: string): HomeWorkspace | undefined {
  const wanted = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (wanted === "" || wanted === "personal" || wanted === "user" || wanted === "me") return workspaces[0];
  return workspaces.find((ws) => ws.key.toLowerCase() === wanted)
    ?? workspaces.find((ws) => ws.name.toLowerCase().replace(/\s+/g, " ") === wanted)
    ?? workspaces.find((ws) => ws.name.toLowerCase().replace(/^the /, "").replace(/ team$/, "") === wanted.replace(/^the /, "").replace(/ team$/, ""));
}

export interface StartedHomeTask {
  id: string;
  /** The submission this call queued in the task thread. */
  queueItemId?: string;
  sessionId: string;
  threadId: string;
  title: string;
  workspace: HomeWorkspaceRef;
}

/**
 * Starts a work thread in one of the person's workspaces and sends the
 * instructions as the person. A team thread is visible to the whole team,
 * like any thread a member starts there. Membership is checked again here,
 * at action time.
 */
export async function startHomeTask(deps: HomeDeps, user: HomeUser, input: {
  workspace: HomeWorkspace; title: string; instructions: string; authorName?: string;
}): Promise<StartedHomeTask> {
  const { workspace } = input;
  if (workspace.owner.type === "team" && !await isTeamMember(deps.db, workspace.owner.id, user.id)) {
    throw new Error(`You are not a member of ${workspace.name}. Pick another workspace.`);
  }
  const meta = { actorUserId: user.id, orgId: user.orgId };
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = workspace.owner.type === "team"
    ? await ensureAssistantExecution(deps, workspace.owner, meta, key)
    : await ensureDefaultAssistantSession(deps, workspace.owner, meta);
  const data = await target.session.toData();
  const thread = await deps.engineHost.ensureFreshThread(target.session, key,
    { userId: data.userId, orgId: data.orgId, workspace: data.workspace }, user.id);
  const title = input.title.trim().slice(0, 120) || "Task";
  const createdAt = thread.toThreadData().createdAt;
  await deps.db.insert(sessionThreads).values({ id: thread.id, sessionId: target.sessionId, createdAt, title })
    .onConflictDoUpdate({ target: sessionThreads.id, set: { title } });
  const receipt = await thread.submitPrompt(homeTaskPrompt(input.instructions), {
    author: { id: user.id, ...(input.authorName ? { name: input.authorName } : {}) },
    metadata: { [HOME_TASK_REPORT_KEY]: true },
  });
  const id = `ht_${randomUUID()}`;
  await deps.db.insert(homeTasks).values({
    id, orgId: user.orgId, userId: user.id, ownerType: workspace.owner.type, ownerId: workspace.owner.id,
    sessionId: target.sessionId, threadId: thread.id, title, queueItemId: receipt.queueItemId || null, createdAt: Date.now(),
  });
  await recordThreadUserActivity(deps.db, { sessionId: target.sessionId, threadId: thread.id, threadCreatedAt: createdAt,
    activityAt: Date.now(), emit: (event) => target.session.emit(event) });
  return { id, sessionId: target.sessionId, threadId: thread.id, title, workspace: { key: workspace.key, name: workspace.name } };
}

/** The first message of a task: the person's instructions, then the git note. */
export function homeTaskPrompt(instructions: string): string {
  return `${instructions.trimEnd()}\n\n${HOME_TASK_GIT_NOTE}`;
}

/** Sends a follow-up from the person into a task they started from home. */
export async function messageHomeTask(deps: HomeDeps, user: HomeUser, threadId: string, text: string, authorName?: string): Promise<StartedHomeTask> {
  const [row] = await deps.db.select().from(homeTasks)
    .where(and(eq(homeTasks.userId, user.id), eq(homeTasks.orgId, user.orgId), eq(homeTasks.threadId, threadId))).limit(1);
  if (!row) throw new Error("No task with that thread id. Call list_tasks to find the task.");
  if (!await canAccessTask(deps, user, row)) throw new Error("You no longer have access to that task.");
  const session = await sessionFor(deps, row);
  const thread = await session.threadById(row.threadId);
  if (!thread) throw new Error("The task's thread no longer exists.");
  const receipt = await thread.submitPrompt(text, { author: { id: user.id, ...(authorName ? { name: authorName } : {}) }, metadata: { [HOME_TASK_REPORT_KEY]: true } });
  const workspaces = await homeWorkspaces(deps.db, user);
  const ws = workspaces.find((w) => w.owner.type === row.ownerType && w.owner.id === row.ownerId);
  return { id: row.id, sessionId: row.sessionId, threadId: row.threadId, title: row.title,
    workspace: { key: ws?.key ?? row.ownerId, name: ws?.name ?? "Workspace" }, ...(receipt.queueItemId ? { queueItemId: receipt.queueItemId } : {}) };
}

export async function sessionFor(deps: HomeDeps, row: { ownerType: string; ownerId: string; sessionId: string; orgId: string; userId: string }): Promise<Session> {
  const owner: Principal = row.ownerType === "team" ? { type: "team", id: row.ownerId } : { type: "user", id: row.ownerId };
  const meta = { actorUserId: row.userId, orgId: row.orgId };
  const root = await ensureDefaultAssistantSession(deps, owner, meta);
  if (root.sessionId === row.sessionId) return root.session;
  const live = deps.engineHost.liveSession(row.sessionId);
  if (live) return live;
  const [execution] = await deps.db.execute(sql`SELECT conversation_key FROM assistant_executions WHERE session_id = ${row.sessionId} LIMIT 1`)
    .then((result) => (result as { rows: Array<{ conversation_key: string }> }).rows);
  if (!execution) throw new Error("The task's session no longer exists.");
  return (await ensureAssistantExecution(deps, owner, meta, execution.conversation_key)).session;
}

/**
 * Crosses a thread out of the person's Tasks: it is done, or no longer
 * relevant. Only the person can do this; Valet asks first. A task they
 * started from home is marked done too. The thread keeps running if it is
 * working: this changes the person's list, not the work. It comes back only
 * when it next needs them (`listHomeTasks`).
 */
export async function dismissHomeTask(db: AppDb, user: HomeUser, thread: { sessionId: string; threadId: string }): Promise<void> {
  const now = Date.now();
  await db.insert(homeTaskDismissals).values({ userId: user.id, orgId: user.orgId, ...thread, dismissedAt: now })
    .onConflictDoUpdate({ target: [homeTaskDismissals.userId, homeTaskDismissals.sessionId, homeTaskDismissals.threadId], set: { dismissedAt: now } });
  await db.update(homeTasks).set({ doneAt: now })
    .where(and(eq(homeTasks.userId, user.id), eq(homeTasks.orgId, user.orgId), eq(homeTasks.sessionId, thread.sessionId),
      eq(homeTasks.threadId, thread.threadId), isNull(homeTasks.doneAt)));
}

/** When the person crossed each thread out, keyed `sessionId:threadId`. */
async function dismissedThreads(db: AppDb, user: HomeUser): Promise<Map<string, number>> {
  const rows = await db.select().from(homeTaskDismissals)
    .where(and(eq(homeTaskDismissals.userId, user.id), eq(homeTaskDismissals.orgId, user.orgId)));
  return new Map(rows.map((row) => [`${row.sessionId}:${row.threadId}`, row.dismissedAt]));
}

type PlanProgress = ReturnType<typeof planProgress>;

/** Plan progress (`update_plan`) of each thread that has a plan, from engine thread metadata. */
async function planProgressByThread(db: AppDb, threads: ReadonlyArray<{ sessionId: string; threadId: string }>): Promise<Map<string, PlanProgress>> {
  const out = new Map<string, PlanProgress>();
  if (threads.length === 0) return out;
  const ids = [...new Set(threads.map((t) => t.threadId))];
  const result = await db.execute(sql`SELECT session_id, id, metadata FROM engine_threads WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`) as {
    rows: Array<{ session_id: string; id: string; metadata: unknown }>;
  };
  for (const row of result.rows) {
    const metadata = typeof row.metadata === "string" ? safeJson(row.metadata) : row.metadata;
    const plan = metadata && typeof metadata === "object" ? readThreadPlan(metadata as Record<string, unknown>) : undefined;
    if (plan && plan.items.length > 0) out.set(`${row.session_id}:${row.id}`, planProgress(plan));
  }
  return out;
}

/** Up to three outputs (shared files, pull requests) of each thread, newest first. */
async function outputsByThread(db: AppDb, threads: ReadonlyArray<{ sessionId: string; threadId: string }>): Promise<Map<string, HomeTaskOutput[]>> {
  const out = new Map<string, HomeTaskOutput[]>();
  if (threads.length === 0) return out;
  const ids = [...new Set(threads.map((t) => t.threadId))];
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`,`);
  const [files, prs] = await Promise.all([
    db.execute(sql`SELECT source_session_id AS session_id, source_thread_id AS thread_id, title, source_memory_path AS path, token, updated_at
      FROM artifacts WHERE source_thread_id IN (${idList}) AND revoked_at IS NULL`) as Promise<{ rows: Array<{ session_id: string; thread_id: string; title: string; path: string; token: string; updated_at: string | number }> }>,
    db.execute(sql`SELECT session_id, thread_id, url, repo, number, state, updated_at FROM thread_pull_requests WHERE thread_id IN (${idList})`) as Promise<{ rows: Array<{ session_id: string; thread_id: string; url: string; repo: string; number: string | number; state: string; updated_at: string | number }> }>,
  ]);
  const add = (key: string, output: HomeTaskOutput) => out.set(key, [...(out.get(key) ?? []), output]);
  for (const row of files.rows) {
    add(`${row.session_id}:${row.thread_id}`, { kind: "file", title: row.title || row.path.split("/").at(-1) || "File", href: `/a/${row.token}`, updatedAt: Number(row.updated_at) });
  }
  for (const row of prs.rows) {
    add(`${row.session_id}:${row.thread_id}`, { kind: "pull_request", title: `${row.repo} #${Number(row.number)}`, href: row.url, state: row.state, updatedAt: Number(row.updated_at) });
  }
  for (const [key, list] of out) out.set(key, list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3));
  return out;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Everything in flight across the person's workspaces, sorted for action:
 * what needs them, what Valet is working on, and tasks they started from
 * home that finished and are not marked done. An unread reply alone is not a
 * task: the thread list shows it. A thread the person crossed out stays out
 * until it needs them again. Each workspace's own visibility rules apply (a
 * private team thread stays private). The home conversation itself is never
 * listed.
 */
export async function listHomeTasks(deps: HomeDeps, user: HomeUser): Promise<HomeTasksResponse> {
  const workspaces = await homeWorkspaces(deps.db, user);
  const started = await visibleStartedTasks(deps, user, workspaces);
  const startedActivity = await startedTaskActivity(deps.db, user, started);
  const viewer = { orgId: user.orgId, userId: user.id };
  const [homeThread, dismissed] = await Promise.all([homeThreadId(deps.db, user), dismissedThreads(deps.db, user)]);
  const perWorkspace = await Promise.all(workspaces.map(async (ws) => {
    const [active, waiting] = await Promise.all([
      listWorkspaceActiveWork(deps.db, user.orgId, ws.owner, 50, undefined, user.id),
      listWaitingThreads(deps.db, user.orgId, ws.owner, user.id),
    ]);
    const savedActive = startedActivity.flatMap((item) => {
      const task = started.find((row) => row.sessionId === item.sessionId && row.threadId === item.threadId
        && row.ownerType === ws.owner.type && row.ownerId === ws.owner.id);
      return task ? [{ ...item, title: task.title }] : [];
    });
    const activeItems = [...active.items, ...savedActive];
    const pairs = [...activeItems, ...waiting];
    const shown = await visibleThreadIds(deps, { ownerType: ws.owner.type }, viewer, pairs);
    const visible = <T extends { sessionId: string; threadId: string }>(rows: T[]) =>
      rows.filter((row) => row.threadId !== homeThread && shown.has(`${row.sessionId}:${row.threadId}`));
    return { ws, active: visible(activeItems), waiting: visible(waiting) };
  }));
  const startedByThread = new Map(started.map((row) => [`${row.sessionId}:${row.threadId}`, row]));
  const allThreads = [
    ...perWorkspace.flatMap(({ active, waiting }) => [...active, ...waiting]),
    ...started.map((row) => ({ sessionId: row.sessionId, threadId: row.threadId })),
  ];
  const [plans, outputs] = await Promise.all([planProgressByThread(deps.db, allThreads), outputsByThread(deps.db, allThreads)]);
  const wsRef = (ws: HomeWorkspace): HomeWorkspaceRef => ({ key: ws.key, name: ws.name });
  const decorate = (item: Omit<HomeTaskItem, "plan" | "homeTaskId" | "outputs">): HomeTaskItem => {
    const key = `${item.sessionId}:${item.threadId}`;
    const plan = plans.get(key);
    const home = startedByThread.get(key);
    const made = outputs.get(key);
    return { ...item, ...(plan ? { plan } : {}), ...(home ? { homeTaskId: home.id } : {}), ...(made?.length ? { outputs: made } : {}) };
  };

  const listed = new Set<string>();
  const needsYou: HomeTaskItem[] = [];
  const working: HomeTaskItem[] = [];
  const finishedFromReplies: HomeTaskItem[] = [];
  // One row per thread: the most urgent state wins.
  const rank = { needs_you: 3, failed: 2, working: 1 } as const;
  const activeByThread = new Map<string, { ws: HomeWorkspace; item: (typeof perWorkspace)[number]["active"][number] }>();
  for (const { ws, active } of perWorkspace) {
    for (const item of active) {
      const key = `${item.sessionId}:${item.threadId}`;
      const prev = activeByThread.get(key);
      if (!prev || rank[item.state] > rank[prev.item.state]) activeByThread.set(key, { ws, item });
    }
  }
  for (const [key, { ws, item }] of activeByThread) {
    listed.add(key);
    const row = decorate({ id: `active:${key}`, sessionId: item.sessionId, threadId: item.threadId, title: item.title,
      workspace: wsRef(ws), state: item.state, updatedAt: item.updatedAt });
    (item.state === "working" ? working : needsYou).push(row);
  }
  for (const { ws, waiting } of perWorkspace) {
    for (const thread of waiting) {
      const key = `${thread.sessionId}:${thread.threadId}`;
      if (listed.has(key)) continue;
      listed.add(key);
      // A task started from home that answered without a question is finished:
      // it waits for the person to mark it done, not for a reply.
      const finishedTask = !thread.question && startedByThread.has(key);
      const row = decorate({ id: `waiting:${key}`, sessionId: thread.sessionId, threadId: thread.threadId, title: thread.title,
        workspace: wsRef(ws), state: finishedTask ? "done" : "waiting", updatedAt: thread.lastAgentActivityAt,
        ...(thread.question ? { detail: thread.question, question: true } : thread.preview ? { detail: thread.preview } : {}),
        ...(thread.unread ? { unread: true } : {}) });
      // A reply without a question is not a task: the thread list shows it.
      if (!thread.question && !finishedTask) continue;
      (thread.question ? needsYou : finishedFromReplies).push(row);
    }
  }
  const finished: HomeTaskItem[] = [...finishedFromReplies];
  for (const row of started) {
    const key = `${row.sessionId}:${row.threadId}`;
    if (listed.has(key)) continue;
    const ws = workspaces.find((w) => w.owner.type === row.ownerType && w.owner.id === row.ownerId);
    if (!ws) continue;
    finished.push(decorate({ id: `task:${row.id}`, sessionId: row.sessionId, threadId: row.threadId, title: row.title,
      workspace: wsRef(ws), state: "done", updatedAt: row.reportedAt ?? row.createdAt }));
  }
  const newest = (a: HomeTaskItem, b: HomeTaskItem) => b.updatedAt - a.updatedAt;
  // A crossed-out thread comes back only for something newer that needs the person.
  const kept = (needs: boolean) => (item: HomeTaskItem) => {
    const at = dismissed.get(`${item.sessionId}:${item.threadId}`);
    return at === undefined || (needs && item.updatedAt > at);
  };
  return { needsYou: needsYou.filter(kept(true)).sort(newest), working: working.filter(kept(false)).sort(newest),
    finished: finished.filter(kept(false)).sort(newest) };
}

async function homeThreadId(db: AppDb, user: HomeUser): Promise<string | undefined> {
  const result = await db.execute(sql`SELECT t.id FROM engine_threads t JOIN agent_sessions s ON s.id = t.session_id
    WHERE t.key = ${HOME_THREAD_KEY} AND s.org_id = ${user.orgId} AND s.owner_type = 'user'
      AND COALESCE(NULLIF(s.owner_id,''), s.user_id) = ${user.id} LIMIT 1`) as { rows: Array<{ id: string }> };
  return result.rows[0]?.id;
}

/** The person's display name, for message attribution. */
export async function userDisplayName(db: AppDb, userId: string): Promise<string | undefined> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name || undefined;
}

/** A plain-text summary of `listHomeTasks` for the assistant. */
export function describeHomeTasks(tasks: HomeTasksResponse): string {
  const line = (item: HomeTaskItem) => {
    const plan = item.plan ? ` · plan ${item.plan.done}/${item.plan.total}${item.plan.current ? ` (now: ${item.plan.current})` : ""}` : "";
    const detail = item.detail ? ` · ${item.detail.slice(0, 160)}` : "";
    return `- [${item.workspace.name}] ${item.title} (${item.state}${plan}) thread_id=${item.threadId}${item.homeTaskId ? ` task_id=${item.homeTaskId}` : ""}${detail}`;
  };
  const section = (name: string, items: HomeTaskItem[]) => items.length ? [`${name} (${items.length}):`, ...items.slice(0, 15).map(line)] : [`${name}: none`];
  return [
    ...section("Needs the person", tasks.needsYou),
    ...section("In progress", tasks.working),
    ...section("Finished tasks started from home, not marked done", tasks.finished),
  ].join("\n");
}

/**
 * Reports back to home when work in a task the person started from home
 * settles: the run their home message started (`start_task`, `message_task`)
 * and background work finishing (a child, a timer, a process). A turn the
 * person drove inside the task thread does not report, nor does any turn
 * while they have the task open. The report names the task and its outcome
 * only. It carries no text from the task thread, because a team thread can
 * hold other people's words and home runs with the person's own access.
 */
export function wireHomeTaskReports(eventStream: EventStream, deps: HomeDeps, viewers: Pick<ActiveViewers, "viewersOf"> = activeViewers): () => void {
  return eventStream.subscribe({ eventTypes: ["submission_settled"] }, (delivered) => {
    const event = delivered.event;
    if (event.type !== "submission_settled") return;
    void reportSettled(deps, viewers, delivered.sessionId, event.queueItemId, event.outcome.outcome).catch((err) => {
      console.error(`[home] task report failed for ${delivered.sessionId}:`, err);
    });
  });
}

/** Background work whose end is worth a line in home. */
const BACKGROUND_SIGNAL = /^(child\.settled|process\.exited|timer\.fired|wakeup\.|watch\.event)/;
/** A background-only update waits this long after the last report. */
const BACKGROUND_REPORT_GAP_MS = 10 * 60_000;

function reportWorthy(item: QueueItem): "home" | "background" | undefined {
  if (item.metadata?.[HOME_TASK_REPORT_KEY] === true) return "home";
  const content = item.content;
  if (content && typeof content === "object" && "kind" in content && content.kind === "signal" && BACKGROUND_SIGNAL.test(content.signalType)) return "background";
  return undefined;
}

async function reportSettled(deps: HomeDeps, viewers: Pick<ActiveViewers, "viewersOf">, sessionId: string, queueItemId: string, outcome: string): Promise<void> {
  if (outcome === "superseded" || outcome === "merged") return;
  const item = await deps.engineStore.getQueueItem(sessionId, queueItemId);
  if (!item) return;
  const kind = reportWorthy(item);
  if (!kind) return;
  const [row] = await deps.db.select().from(homeTasks)
    .where(and(eq(homeTasks.sessionId, sessionId), eq(homeTasks.threadId, item.threadId), isNull(homeTasks.doneAt))).limit(1);
  if (!row) return;
  const user = { id: row.userId, orgId: row.orgId };
  if (!await canAccessTask(deps, user, row)) return;
  const now = Date.now();
  if (kind === "background" && row.reportedAt && now - row.reportedAt < BACKGROUND_REPORT_GAP_MS) return;
  // The person is looking at the task: they see the result there.
  if (viewers.viewersOf(sessionId, item.threadId).some((viewer) => viewer.userId === row.userId)) return;
  const first = row.reportedAt === null;
  await deps.db.update(homeTasks).set({ reportedAt: now }).where(eq(homeTasks.id, row.id));
  const { thread } = await ensureHomeThread(deps, user);
  const workspaces = await homeWorkspaces(deps.db, user);
  const ws = workspaces.find((w) => w.owner.type === row.ownerType && w.owner.id === row.ownerId);
  const state = outcome === "failed" ? "failed" : outcome === "aborted" ? "was stopped" : first ? "finished its first run" : "finished a run";
  await thread.submitPrompt({
    kind: "signal",
    signalType: "home.task_report",
    body: `The task "${row.title}" in ${ws?.name ?? "a workspace"} ${state}. thread_id=${row.threadId} task_id=${row.id}. ` +
      "Tell the person in one or two short lines what happened and whether they need to do anything. " +
      (outcome === "failed" || outcome === "aborted" ? "" :
        "If the task looks complete and they need to do nothing, end with the question \"Mark it done?\". " +
        "Only the person marks a task done: call mark_task_done after they say yes in their own message. ") +
      "Call read_task only if you need the task's result. Do not start new work.",
    attributes: { task_id: row.id, thread_id: row.threadId, outcome, title: row.title },
  }, { dispatchId: `home-report:${row.id}:${queueItemId}`, queueMode: "followup" });
}

/**
 * The newest messages of a task the person started from home, as plain
 * text, for home to summarize a result. Only the person's own open tasks.
 */
export async function readHomeTask(deps: HomeDeps, user: HomeUser, threadId: string, limit = 6): Promise<string> {
  const [row] = await deps.db.select().from(homeTasks)
    .where(and(eq(homeTasks.userId, user.id), eq(homeTasks.orgId, user.orgId), eq(homeTasks.threadId, threadId))).limit(1);
  if (!row) throw new Error("No task with that thread id. Call list_tasks to find the task.");
  if (!await canAccessTask(deps, user, row)) throw new Error("You no longer have access to that task.");
  // The newest messages only: tool and system entries sit between them, so
  // read a tail with room for them instead of the whole transcript.
  const entries = await deps.engineStore.getEntries(row.sessionId, row.threadId, { limit: limit * 10 });
  const messages = entries.flatMap((entry) => entry.type === "message" && (entry.role === "user" || entry.role === "assistant") && entry.content
    ? [`## ${entry.role === "user" ? (entry.author?.name ?? "person") : "Valet"}\n${entry.content.slice(0, 2000)}`] : []);
  return [`# ${row.title}`, ...messages.slice(-limit)].join("\n\n");
}
