import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { homeTasks, sessionThreads, teamMembers, teams, threadPullRequests, workflowSchedules } from "../schema/index.js";
import { HOME_THREAD_KEY, dismissHomeTask, ensureHomeThread, homeTaskPrompt, homeWorkspaces, matchWorkspace, messageHomeTask, readHomeTask, startHomeTask, wireHomeTaskReports } from "../home/service.js";
import { buildHomeTools } from "../home/tools.js";
import type { HomeConversationResponse, HomeTasksResponse, ListThreadsResponse } from "../wire/types.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; faux?.unregister(); faux = undefined; vi.unstubAllEnvs(); });

const USER = { id: "local-user", orgId: "local-org" };

async function boot(replies = 0): Promise<TestApi> {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  faux.appendResponses(Array.from({ length: replies }, () => () => fauxAssistantMessage("Done.")));
  api = await bootTestApi();
  return api;
}

async function addTeam(test: TestApi, id: string, name: string) {
  await test.providers.db.insert(teams).values({ id, orgId: USER.orgId, name, createdAt: 1 });
  await test.providers.db.insert(teamMembers).values({ teamId: id, userId: USER.id, role: "member" });
}

describe("home conversation", () => {
  it("opens one home thread in the personal session, idempotently, and keeps it out of thread lists", async () => {
    const test = await boot();
    const first = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
    const again = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
    expect(again).toEqual(first);
    const thread = await test.providers.engineStore.getThread(first.sessionId, first.threadId);
    expect(thread?.key).toBe(HOME_THREAD_KEY);
    const listed = await (await fetch(`${test.baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/threads?limit=50`)).json() as ListThreadsResponse;
    expect(listed.threads.map((t) => t.id)).not.toContain(first.threadId);
    const selected = await (await fetch(`${test.baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/threads?limit=50&threadId=${first.threadId}`)).json() as ListThreadsResponse;
    expect(selected.threads.map(t => t.id)).toContain(first.threadId);
  });

  it("names the home thread Home in every thread response, over any stored title", async () => {
    const test = await boot();
    const home = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
    // A title written before Home had one name, or by a client that renames threads.
    await test.providers.db.update(sessionThreads).set({ title: "Valet Mobile Tap Bug Investigation" }).where(eq(sessionThreads.id, home.threadId));
    const detail = await (await fetch(`${test.baseUrl}/api/threads/${home.threadId}`)).json() as { title: string | null };
    expect(detail.title).toBe("Home");
    const fixed = await (await fetch(`${test.baseUrl}/api/sessions/${encodeURIComponent(home.sessionId)}/threads?fixedId=${home.threadId}&fixedOnly=1`)).json() as ListThreadsResponse;
    expect(fixed.threads.find((t) => t.id === home.threadId)?.title).toBe("Home");
    const all = await (await fetch(`${test.baseUrl}/api/sessions/${encodeURIComponent(home.sessionId)}/threads`)).json() as ListThreadsResponse;
    expect(all.threads.find((t) => t.id === home.threadId)?.title).toBe("Home");
  });

  it("refuses to archive or share the home thread, and still clears either", async () => {
    const test = await boot();
    const home = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
    const patch = (body: unknown) => fetch(`${test.baseUrl}/api/threads/${home.threadId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const archived = await patch({ archived: true });
    expect(archived.status).toBe(400);
    expect(((await archived.json()) as { error: string }).error).toContain("cannot be archived");
    for (const share of ["view", "reply"]) {
      const shared = await patch({ share });
      expect(shared.status).toBe(400);
      expect(((await shared.json()) as { error: string }).error).toContain("cannot be shared");
    }
    const detail = await (await fetch(`${test.baseUrl}/api/threads/${home.threadId}`)).json() as { archivedAt: number | null; share?: string };
    expect(detail.archivedAt).toBeNull();
    expect(detail.share).toBeUndefined();
    // A guest link never opens: the home thread has no share to admit through.
    expect((await fetch(`${test.baseUrl}/api/threads/${home.threadId}/messages`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    // Clearing is harmless and stays allowed, so an older archived or shared row can be repaired.
    expect((await patch({ archived: false })).status).toBe(200);
    expect((await patch({ share: "off" })).status).toBe(200);
  });

  it("refuses to rename the home thread and keeps other settings editable", async () => {
    const test = await boot();
    const home = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
    const patch = (body: unknown) => fetch(`${test.baseUrl}/api/threads/${home.threadId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const renamed = await patch({ title: "Incident triage" });
    expect(renamed.status).toBe(400);
    expect(((await renamed.json()) as { error: string }).error).toContain("Home keeps its name");
    const detail = await (await fetch(`${test.baseUrl}/api/threads/${home.threadId}`)).json() as { title: string | null };
    expect(detail.title).toBe("Home");
    // Other settings are not the name: a model change still lands.
    const model = await patch({ model: null });
    expect(model.status).toBe(200);
  });

  it("creates no routine when Home opens", async () => {
    const test = await boot();
    await fetch(`${test.baseUrl}/api/home`, { method: "POST" });
    await fetch(`${test.baseUrl}/api/home`, { method: "POST" });
    const rows = await test.providers.db.select().from(workflowSchedules)
      .where(and(eq(workflowSchedules.orgId, USER.orgId), eq(workflowSchedules.ownerId, USER.id)));
    expect(rows).toEqual([]);
  });
});

describe("home tasks", () => {
  it("queues a task report without cancelling an open Home question", async () => {
    const test = await boot();
    faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which repo?", intent: "Ask which repository to use before starting the task." })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Task done."), fauxAssistantMessage("Home done."), fauxAssistantMessage("Report done."),
    ]);
    const { session, thread } = await ensureHomeThread(test.providers, USER);
    const active = await thread.submitPrompt("Help me choose", { author: { id: USER.id, interactive: true } });
    await vi.waitFor(() => expect(thread.pendingDecisionGates()).toHaveLength(1), { timeout: 10_000 });
    const gate = thread.pendingDecisionGates()[0];
    if (!gate) throw new Error("Expected Home question");
    const stop = wireHomeTaskReports(test.providers.eventStream, test.providers, { viewersOf: () => [] });
    try {
      const [workspace] = await homeWorkspaces(test.providers.db, USER);
      if (!workspace) throw new Error("Expected personal workspace");
      const task = await startHomeTask(test.providers, USER, { workspace, title: "Task", instructions: "Finish this task." });
      const [row] = await test.providers.db.select().from(homeTasks).where(eq(homeTasks.id, task.id));
      await vi.waitFor(async () => expect(await test.providers.engineStore.getQueueItemByDispatchId(session.id, `home-report:${task.id}:${row?.queueItemId}`)).not.toBeNull(), { timeout: 10_000 });
      expect((await test.providers.engineStore.getQueueItem(session.id, active.queueItemId))?.status).toBe("blocked_on_decision_gate");
      expect(thread.pendingDecisionGates().map(g => g.id)).toContain(gate.id);
    } finally {
      stop();
      if (thread.pendingDecisionGates().some(g => g.id === gate.id)) await session.resolveDecision(gate.id, { value: "org/repo", resolvedBy: USER.id, resolvedAt: Date.now() });
    }
  });
  it("starts a task in a team workspace as the person and lists it under Tasks with its workspace", async () => {
    const test = await boot(1);
    await addTeam(test, "team-ops", "Ops Team");
    const workspaces = await homeWorkspaces(test.providers.db, USER);
    expect(workspaces.map((ws) => ws.name)).toEqual(["Personal", "Ops Team"]);
    const task = await startHomeTask(test.providers, USER, { workspace: matchWorkspace(workspaces, "ops")!, title: "Check the deploy",
      instructions: "Check whether the deploy finished." });
    expect(task.workspace).toEqual({ key: "team-ops", name: "Ops Team" });
    const [row] = await test.providers.db.select().from(homeTasks).where(eq(homeTasks.id, task.id));
    const submission = await test.providers.engineStore.getQueueItem(task.sessionId, row!.queueItemId!);
    expect(submission?.author?.id).toBe(USER.id);
    expect(submission?.threadId).toBe(task.threadId);
    expect(submission?.content).toBe(homeTaskPrompt("Check whether the deploy finished."));
    expect(submission?.content).toContain("start a child with the task tool and pass repo");
    const tasks = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    const all = [...tasks.needsYou, ...tasks.working, ...tasks.finished];
    const listed = all.find((item) => item.threadId === task.threadId);
    expect(listed).toMatchObject({ title: "Check the deploy", workspace: { key: "team-ops", name: "Ops Team" }, homeTaskId: task.id });
  });

  it("refuses a task in a team the person no longer belongs to", async () => {
    const test = await boot();
    await addTeam(test, "team-old", "Old Team");
    const workspaces = await homeWorkspaces(test.providers.db, USER);
    await test.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "team-old"));
    await expect(startHomeTask(test.providers, USER, { workspace: matchWorkspace(workspaces, "Old Team")!, title: "x", instructions: "y" }))
      .rejects.toThrow(/not a member of Old Team/);
  });

  it("reports back to home when a run it started settles, but not while the person watches the task", async () => {
    const test = await boot(4);
    let watching = false;
    const viewers = { viewersOf: () => watching ? [{ userId: USER.id, name: "Me", typing: false }] : [] };
    const stop = wireHomeTaskReports(test.providers.eventStream, test.providers, viewers);
    try {
      const workspaces = await homeWorkspaces(test.providers.db, USER);
      const task = await startHomeTask(test.providers, USER, { workspace: workspaces[0]!, title: "Summarize the call", instructions: "Summarize it." });
      const [row] = await test.providers.db.select().from(homeTasks).where(eq(homeTasks.id, task.id));
      const home = await (await fetch(`${test.baseUrl}/api/home`, { method: "POST" })).json() as HomeConversationResponse;
      await vi.waitFor(async () => {
        const report = await test.providers.engineStore.getQueueItemByDispatchId(home.sessionId, `home-report:${task.id}:${row!.queueItemId}`);
        expect(report?.threadId).toBe(home.threadId);
      }, { timeout: 10_000 });

      // A follow-up through message_task stays quiet while the person has the task open...
      watching = true;
      const watched = await messageHomeTask(test.providers, USER, task.threadId, "Add the action items.");
      await vi.waitFor(async () => {
        const items = await test.providers.engineStore.listUnsettledSubmissions(task.sessionId);
        expect(items.filter((item) => item.threadId === task.threadId)).toEqual([]);
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await test.providers.engineStore.getQueueItemByDispatchId(home.sessionId, `home-report:${task.id}:${watched.queueItemId}`)).toBeNull();
      // ...and reports again once they are away.
      watching = false;
      const away = await messageHomeTask(test.providers, USER, task.threadId, "Now send me the summary.");
      await vi.waitFor(async () => {
        expect(await test.providers.engineStore.getQueueItemByDispatchId(home.sessionId, `home-report:${task.id}:${away.queueItemId}`)).not.toBeNull();
      }, { timeout: 10_000 });
    } finally {
      stop();
    }
  });

  it("crosses a finished task out of Tasks and marks it done", async () => {
    const test = await boot(1);
    const workspaces = await homeWorkspaces(test.providers.db, USER);
    const task = await startHomeTask(test.providers, USER, { workspace: workspaces[0]!, title: "Tidy notes", instructions: "Tidy them." });
    await vi.waitFor(async () => {
      expect(await test.providers.engineStore.listUnsettledSubmissions(task.sessionId)).toEqual([]);
    });
    const before = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    expect(before.finished.map((item) => item.threadId)).toContain(task.threadId);
    const dismiss = (body: unknown) => fetch(`${test.baseUrl}/api/home/tasks/dismiss`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await dismiss({ sessionId: task.sessionId, threadId: task.threadId })).status).toBe(204);
    const after = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    expect([...after.needsYou, ...after.working, ...after.finished].map((item) => item.threadId)).not.toContain(task.threadId);
    const [row] = await test.providers.db.select().from(homeTasks).where(eq(homeTasks.id, task.id));
    expect(row?.doneAt).toBeTypeOf("number");
    expect((await dismiss({ threadId: task.threadId })).status).toBe(400);
  });

  it("keeps a crossed-out thread out of Tasks until something newer needs the person", async () => {
    const test = await boot(1);
    const [workspace] = await homeWorkspaces(test.providers.db, USER);
    if (!workspace) throw new Error("Expected personal workspace");
    const task = await startHomeTask(test.providers, USER, { workspace, title: "Long job", instructions: "Run it." });
    await vi.waitFor(async () => {
      expect(await test.providers.engineStore.listUnsettledSubmissions(task.sessionId)).toEqual([]);
    });
    const list = async () => await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    await test.providers.db.execute(sql`INSERT INTO engine_queue_items
      (id,session_id,thread_id,status,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
      VALUES ('still-running',${task.sessionId},${task.threadId},'running','{}',0,1,9999999999999,1,1)`);
    expect((await list()).working.map((item) => item.threadId)).toContain(task.threadId);
    await dismissHomeTask(test.providers.db, USER, { sessionId: task.sessionId, threadId: task.threadId });
    // Work that keeps running does not bring it back.
    const hidden = await list();
    expect([...hidden.needsYou, ...hidden.working, ...hidden.finished].map((item) => item.threadId)).not.toContain(task.threadId);
    // A new approval after the cross-out does.
    const later = Date.now() + 60_000;
    await test.providers.db.execute(sql`INSERT INTO engine_queue_items
      (id,session_id,thread_id,status,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
      VALUES ('needs-approval',${task.sessionId},${task.threadId},'blocked_on_decision_gate','{}',0,1,9999999999999,${later},${later})`);
    expect((await list()).needsYou.map((item) => item.threadId)).toContain(task.threadId);
  });

  it("rechecks a saved team's thread audience before reading, messaging, or listing its outputs", async () => {
    const test = await boot(1);
    await addTeam(test, "team-private", "Private Team");
    const ws = matchWorkspace(await homeWorkspaces(test.providers.db, USER), "Private Team");
    if (!ws) throw new Error("Expected team workspace");
    const task = await startHomeTask(test.providers, USER, { workspace: ws, title: "Private result", instructions: "Summarize it." });
    await vi.waitFor(async () => {
      expect(await test.providers.engineStore.listUnsettledSubmissions(task.sessionId)).toEqual([]);
    });
    // The execution inherits the root anchor's audience. A saved Home task
    // must not bypass it if the anchor is now private to another person.
    await test.providers.db.execute(sql`UPDATE engine_threads SET key='app-assistant:another-person'
      WHERE (session_id,id) IN (SELECT parent_session_id,parent_thread_id FROM engine_sessions WHERE id=${task.sessionId})`);
    await expect(readHomeTask(test.providers, USER, task.threadId)).rejects.toThrow(/no longer have access/);
    await expect(messageHomeTask(test.providers, USER, task.threadId, "Continue")).rejects.toThrow(/no longer have access/);
    const tasks = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    expect([...tasks.needsYou, ...tasks.working, ...tasks.finished].map((item) => item.threadId)).not.toContain(task.threadId);
  });

  it("keeps a saved task working when newer queue items fill the active-work page", async () => {
    const test = await boot(1);
    const [workspace] = await homeWorkspaces(test.providers.db, USER);
    if (!workspace) throw new Error("Expected personal workspace");
    const task = await startHomeTask(test.providers, USER, { workspace, title: "Still running", instructions: "Summarize it." });
    await vi.waitFor(async () => {
      expect(await test.providers.engineStore.listUnsettledSubmissions(task.sessionId)).toEqual([]);
    });
    // Fifty newer items occupy the first page. The older task is still live.
    await test.providers.db.execute(sql`INSERT INTO engine_queue_items
      (id,session_id,thread_id,status,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
      SELECT 'busy-'||n,${task.sessionId},'other-thread','running','{}',0,1,9999999999999,100,100+n FROM generate_series(1,50) AS n`);
    await test.providers.db.execute(sql`INSERT INTO engine_queue_items
      (id,session_id,thread_id,status,content,attempt_count,max_attempts,timeout_at,created_at,updated_at)
      VALUES ('older-task',${task.sessionId},${task.threadId},'running','{}',0,1,9999999999999,1,1)`);
    const tasks = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    expect(tasks.working.map((item) => item.threadId)).toContain(task.threadId);
    expect(tasks.finished.map((item) => item.threadId)).not.toContain(task.threadId);
  });
});

describe("home task outputs and brief", () => {
  it("lists a task's pull request as an output", async () => {
    const test = await boot(1);
    const workspaces = await homeWorkspaces(test.providers.db, USER);
    const task = await startHomeTask(test.providers, USER, { workspace: workspaces[0]!, title: "Fix the drawer", instructions: "Fix it." });
    await test.providers.db.insert(threadPullRequests).values({ sessionId: task.sessionId, threadId: task.threadId, url: "https://github.com/o/r/pull/7",
      repo: "o/r", number: 7, state: "merged", createdAt: 1, updatedAt: 2, checkedAt: 2 });
    const tasks = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    const row = [...tasks.needsYou, ...tasks.working, ...tasks.finished].find((item) => item.threadId === task.threadId);
    expect(row?.outputs).toEqual([{ kind: "pull_request", title: "o/r #7", href: "https://github.com/o/r/pull/7", state: "merged", updatedAt: 2 }]);
  });
});

describe("reading a task", () => {
  it("reads the newest messages of the person's own task only", async () => {
    const test = await boot(1);
    const workspaces = await homeWorkspaces(test.providers.db, USER);
    const task = await startHomeTask(test.providers, USER, { workspace: workspaces[0]!, title: "Plan the offsite", instructions: "List three venues." });
    await vi.waitFor(async () => {
      expect(await readHomeTask(test.providers, USER, task.threadId)).toContain("Done.");
    }, { timeout: 10_000 });
    expect(await readHomeTask(test.providers, USER, task.threadId)).toMatch(/^# Plan the offsite[\s\S]*List three venues\./);
    await expect(readHomeTask(test.providers, { id: "someone-else", orgId: USER.orgId }, task.threadId)).rejects.toThrow(/No task/);
  });
});

describe("home tools", () => {
  const ctx = (partial: Partial<ToolContext>): ToolContext => ({ userId: USER.id, orgId: USER.orgId, sessionId: "s", threadId: "t",
    owner: { type: "user", id: USER.id }, ...partial } as ToolContext);

  it("starts a task only on a turn the person wrote", async () => {
    const test = await boot();
    const [start] = buildHomeTools(() => test.providers);
    const signal = await start!.execute({ workspace: "personal", title: "x", instructions: "y" }, ctx({}));
    expect(signal.text).toContain("[start_task_refused]");
    const other = await start!.execute({ workspace: "personal", title: "x", instructions: "y" }, ctx({ interactiveActor: { id: "someone-else" } }));
    expect(other.text).toContain("[start_task_refused]");
    const team = await start!.execute({ workspace: "personal", title: "x", instructions: "y" },
      ctx({ owner: { type: "team", id: "t" }, interactiveActor: { id: USER.id } }));
    expect(team.text).toContain("only in a personal workspace");
  });

  it("names the workspaces it knows when the workspace does not match", async () => {
    const test = await boot();
    await addTeam(test, "team-ops", "Ops Team");
    const [start] = buildHomeTools(() => test.providers);
    const result = await start!.execute({ workspace: "Finance", title: "x", instructions: "y" }, ctx({ interactiveActor: { id: USER.id } }));
    expect(result.text).toBe('[start_task_error] No workspace named "Finance". Choose one of: Personal, Ops Team.');
  });

  it("marks a task done only on a turn the person wrote", async () => {
    const test = await boot(1);
    const markDone = buildHomeTools(() => test.providers).find((tool) => tool.name === "mark_task_done");
    if (!markDone) throw new Error("Expected mark_task_done");
    const [workspace] = await homeWorkspaces(test.providers.db, USER);
    if (!workspace) throw new Error("Expected personal workspace");
    const task = await startHomeTask(test.providers, USER, { workspace, title: "Send notes", instructions: "Send them." });
    await vi.waitFor(async () => {
      expect(await test.providers.engineStore.listUnsettledSubmissions(task.sessionId)).toEqual([]);
    });
    expect((await markDone.execute({ thread_id: task.threadId }, ctx({}))).text).toContain("[mark_task_done_refused]");
    expect((await markDone.execute({ thread_id: "no-such-thread" }, ctx({ interactiveActor: { id: USER.id } }))).text)
      .toContain("[mark_task_done_error] No task with that thread id");
    const done = await markDone.execute({ thread_id: task.threadId }, ctx({ interactiveActor: { id: USER.id } }));
    expect(done.text).toContain("Send notes");
    const tasks = await (await fetch(`${test.baseUrl}/api/home/tasks`)).json() as HomeTasksResponse;
    expect(tasks.finished.map((item) => item.threadId)).not.toContain(task.threadId);
  });
});

describe("matchWorkspace", () => {
  const workspaces = [
    { key: "user", name: "Personal", owner: { type: "user" as const, id: "u" } },
    { key: "team-1", name: "Platform Team", owner: { type: "team" as const, id: "team-1" } },
  ];
  it.each([["personal", "user"], ["me", "user"], ["team-1", "team-1"], ["platform team", "team-1"], ["Platform", "team-1"], ["the platform team", "team-1"]])(
    "matches %s", (input, key) => { expect(matchWorkspace(workspaces, input)?.key).toBe(key); });
  it("matches nothing for an unknown name", () => { expect(matchWorkspace(workspaces, "finance")).toBeUndefined(); });
});
