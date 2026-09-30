import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { sessionThreads } from "../schema/index.js";
import type { ListThreadsResponse, WaitingThreadsResponse } from "../wire/types.js";
import {
  lastAgentAsk, listWaitingThreads, parsePullRequestUrl, pullRequestWebhookState, recordThreadPullRequest,
  setPullRequestState, wireThreadPullRequests,
} from "./thread-read-state.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function createThread(baseUrl: string): Promise<{ id: string; sessionId: string }> {
  const res = await fetch(`${baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return await res.json() as { id: string; sessionId: string };
}
async function agentMessage(a: TestApi, thread: { id: string; sessionId: string }, at: number) {
  await a.providers.db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at)
    VALUES (${`m-${thread.id}-${at}`},${thread.sessionId},${thread.id},'message','assistant','Which one first?',${at})`);
}
async function listThreads(a: TestApi, sessionId: string) {
  return (await (await fetch(`${a.baseUrl}/api/sessions/${sessionId}/threads`)).json() as ListThreadsResponse).threads;
}

it("parses only github.com pull request URLs", () => {
  expect(parsePullRequestUrl("https://github.com/acme/app/pull/42")).toEqual({ owner: "acme", repo: "app", number: 42 });
  expect(parsePullRequestUrl("https://github.com/acme/app/issues/42")).toBeNull();
  expect(parsePullRequestUrl("https://evil.example/acme/app/pull/42")).toBeNull();
  expect(parsePullRequestUrl("https://github.acme.internal/acme/app/pull/42", "https://github.acme.internal")).toEqual({ owner: "acme", repo: "app", number: 42 });
  expect(parsePullRequestUrl("https://github.com/acme/app/pull/42", "https://github.acme.internal")).toBeNull();
  expect(parsePullRequestUrl("https://github.com/acme/app/pull/42/files")).toBeNull();
  expect(pullRequestWebhookState({ pull_request: { html_url: "https://github.com/a/b/pull/1", state: "closed", merged: true } }))
    .toEqual({ url: "https://github.com/a/b/pull/1", state: "merged" });
  expect(pullRequestWebhookState({ pull_request: { html_url: "https://github.com/a/b/pull/1", state: "closed", merged: false } })?.state).toBe("closed");
  expect(pullRequestWebhookState({ action: "opened" })).toBeNull();
});

it("finds the question an agent message asks, or its last sentence", () => {
  expect(lastAgentAsk("The bump is open as **acme/app#8**. Should I merge it once CI passes?\n\nI can also wait."))
    .toEqual({ question: "Should I merge it once CI passes?" });
  expect(lastAgentAsk("Merged as acme/app#12 with gpt-5.6. The lockfile pins typebox again."))
    .toEqual({ preview: "The lockfile pins typebox again." });
  expect(lastAgentAsk("```ts\nwhy?\n```\nDone.")).toEqual({ preview: "Done." });
  expect(lastAgentAsk("")).toEqual({});
});

it("marks a thread unread after an agent message and read once the viewer opens it", async () => {
  api = await bootTestApi();
  const thread = await createThread(api.baseUrl);
  await agentMessage(api, thread, Date.now() + 1_000);
  const [before] = (await listThreads(api, thread.sessionId)).filter(t => t.id === thread.id);
  expect(before?.lastAgentActivityAt).toBeGreaterThan(before?.readAt ?? 0);

  const read = await fetch(`${api.baseUrl}/api/sessions/${thread.sessionId}/threads/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadIds: [thread.id, "not-in-session"] }),
  });
  expect(read.status).toBe(204);
  const [after] = (await listThreads(api, thread.sessionId)).filter(t => t.id === thread.id);
  expect(after?.readAt).toBeTypeOf("number");
  expect((await fetch(`${api.baseUrl}/api/sessions/${thread.sessionId}/threads/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadIds: "x" }),
  })).status).toBe(400);
  // A malformed body is refused rather than read as "mark every thread".
  expect((await fetch(`${api.baseUrl}/api/sessions/${thread.sessionId}/threads/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  })).status).toBe(400);
});

it("records pull requests a thread creates and follows their GitHub state", async () => {
  api = await bootTestApi();
  const thread = await createThread(api.baseUrl);
  const stop = wireThreadPullRequests(api.providers.eventStream, api.providers.db);
  await api.providers.eventStream.append({ sessionId: thread.sessionId, threadId: thread.id, timestamp: Date.now(), event: {
    type: "tool_end", threadId: thread.id, tool: "bash", result: "https://github.com/acme/app/pull/7", isError: false,
    outcome: { kind: "pull_request_created", url: "https://github.com/acme/app/pull/7" },
  } }, "tool-end-7");
  // A result that only mentions a pull request records nothing.
  await api.providers.eventStream.append({ sessionId: thread.sessionId, threadId: thread.id, timestamp: Date.now(), event: {
    type: "tool_end", threadId: thread.id, tool: "bash", result: "https://github.com/acme/app/pull/8", isError: false,
  } }, "tool-end-8");
  await expect.poll(async () => (await listThreads(api!, thread.sessionId)).find(t => t.id === thread.id)?.pullRequests)
    .toEqual([{ url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7, state: "open" }]);
  stop();
  expect(await recordThreadPullRequest(api.providers.db, { sessionId: thread.sessionId, threadId: thread.id, url: "https://github.com/acme/app/pull/9" })).toBe(true);
  await setPullRequestState(api.providers.db, "https://github.com/acme/app/pull/7", "merged");
  const prs = (await listThreads(api, thread.sessionId)).find(t => t.id === thread.id)?.pullRequests;
  expect(prs?.map(pr => [pr.number, pr.state])).toEqual([[7, "merged"], [9, "open"]]);
});

it("lists threads that wait on a reply until someone replies or archives them", async () => {
  api = await bootTestApi();
  const now = Date.now();
  const waiting = await createThread(api.baseUrl);
  const answered = await createThread(api.baseUrl);
  const untouched = await createThread(api.baseUrl);
  // A person acting on a thread creates its metadata row; an untouched thread has none.
  await api.providers.db.insert(sessionThreads).values([waiting, answered].map(t => ({
    id: t.id, sessionId: t.sessionId, createdAt: now - 60_000, lastUserActivityAt: now - 10_000,
  })));
  await agentMessage(api, waiting, now - 5_000);
  await agentMessage(api, answered, now - 20_000);
  await agentMessage(api, untouched, now - 5_000);

  const res = await fetch(`${api.baseUrl}/api/workspaces/user/waiting`);
  expect(res.status).toBe(200);
  const body = await res.json() as WaitingThreadsResponse;
  expect(body.threads.map(t => t.threadId)).toEqual([waiting.id]);
  expect(body.threads[0]).toMatchObject({ unread: true, question: "Which one first?" });

  await api.providers.db.update(sessionThreads).set({ archivedAt: now }).where(sql`id = ${waiting.id}`);
  expect(await listWaitingThreads(api.providers.db, "local-org", { type: "user", id: "local-user" }, "local-user")).toEqual([]);
});
