import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { eq, sql } from "drizzle-orm";
import { agentSessions, channelMessages, childWatches, eventSubscriptions, sessionThreads, threadPullRequests } from "../schema/index.js";
import { linkIdentity } from "../channels/identity-links.js";
import { recordDelegatedPullRequest } from "../services/thread-pull-requests.js";
import { createTeam } from "../services/teams.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import { recentTerminalReview, recordActionChannelMessage, recordChannelMessage, recordTerminalPullRequestWrite, threadForPullRequest, wasSentByValet } from "../services/channel-messages.js";
import type { ChannelDetailResponse, ListChannelsResponse, ThreadChannelActivity, ListThreadsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

/** Connects the org Slack bot and answers Slack's channel checks: `members`
 * lists each private channel's members; any other channel is public. */
async function connectSlack(a: TestApi, members: Record<string, string[]> = {}) {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const privateMembers = members[channel];
    const body = url.pathname.endsWith("conversations.members")
      ? { ok: true, members: privateMembers ?? [] }
      : { ok: true, channel: { name: channel.toLowerCase(), is_private: privateMembers !== undefined } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

const owner = { type: "user" as const, id: "local-user" };

async function runtime(a: TestApi) {
  return await ensureDefaultAssistantSession(a.providers, owner, { actorUserId: "local-user", orgId: "local-org" });
}

it("lists a workspace's Slack channel with its listener, thread, and messages, and links the thread back", async () => {
  api = await bootTestApi();
  await connectSlack(api);
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("slack:CENG:1700.1");
  await api.providers.db.insert(eventSubscriptions).values({
    id: "listen-eng", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Listen in eng",
    eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "in", value: ["CENG"], labels: ["eng"] }],
    target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  await recordChannelMessage(api.providers.db, {
    orgId: "local-org", sessionId, threadId: thread.id, channelKey: "slack:CENG", conversationKey: "slack:CENG:1700.1",
    providerMessageId: "1700.1", direction: "in", author: "Dana", text: "Is staging up?", createdAt: 10,
  });
  // A repeat of the same provider message is ignored.
  await recordChannelMessage(api.providers.db, {
    orgId: "local-org", sessionId, threadId: thread.id, channelKey: "slack:CENG", conversationKey: "slack:CENG:1700.1",
    providerMessageId: "1700.1", direction: "in", author: "Dana", text: "Is staging up?", createdAt: 10,
  });

  const list = await (await fetch(`${api.baseUrl}/api/workspaces/user/channels`)).json() as ListChannelsResponse;
  expect(list.channels).toHaveLength(1);
  expect(list.channels[0]).toMatchObject({
    key: "slack:CENG", provider: "slack", name: "#eng", conversationCount: 1, messageCount: 1,
    listeners: [{ subscriptionId: "listen-eng", editable: true, everywhere: false }],
  });

  const detail = await (await fetch(`${api.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("slack:CENG")}`)).json() as ChannelDetailResponse;
  expect(detail.conversations).toEqual([expect.objectContaining({ threadId: thread.id, url: "https://slack.com/archives/CENG/p17001" })]);
  expect(detail.messages).toEqual([expect.objectContaining({ author: "Dana", direction: "in", text: "Is staging up?" })]);

  const threads = await (await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads`)).json() as ListThreadsResponse;
  expect(threads.threads.find((t) => t.id === thread.id)?.channel).toEqual({
    key: "slack:CENG", provider: "slack", conversationUrl: "https://slack.com/archives/CENG/p17001",
  });
  const activity = await (await fetch(`${api.baseUrl}/api/sessions/${sessionId}/threads/${thread.id}/channel-activity`)).json() as ThreadChannelActivity;
  expect(activity).toMatchObject({ total: 1, latest: { text: "Is staging up?", author: "Dana" } });

  expect((await fetch(`${api.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("slack:COTHER")}`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/workspaces/user/channel`)).status).toBe(400);
});

it("records one message for each workspace it reached, and reads a pattern filter as broad", async () => {
  api = await bootTestApi();
  await connectSlack(api);
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("slack:CENG:1700.1");
  const message = {
    orgId: "local-org", threadId: thread.id, channelKey: "slack:CENG", conversationKey: "slack:CENG:1700.1",
    providerMessageId: "1700.2", direction: "in" as const, text: "hello",
  };
  await recordChannelMessage(api.providers.db, { ...message, sessionId });
  await recordChannelMessage(api.providers.db, { ...message, sessionId: "another-runtime" });
  const rows = await api.providers.db.select().from(channelMessages);
  expect(rows.map((row) => row.sessionId).sort()).toEqual(["another-runtime", sessionId].sort());

  await api.providers.db.insert(eventSubscriptions).values({
    id: "listen-prefix", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Prefix",
    eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "prefix", value: "C" }],
    target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  const list = await (await fetch(`${api.baseUrl}/api/workspaces/user/channels`)).json() as ListChannelsResponse;
  expect(list.channels.map((channel) => channel.key)).toEqual(["slack:CENG"]);
  expect(list.channels[0]?.listeners).toEqual([expect.objectContaining({ subscriptionId: "listen-prefix", everywhere: true })]);
});

it("shows a private Slack channel only to a viewer whose linked Slack account is a member", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("slack:CSECRET:1700.1");
  await recordChannelMessage(api.providers.db, {
    orgId: "local-org", sessionId, threadId: thread.id, channelKey: "slack:CSECRET", conversationKey: "slack:CSECRET:1700.1",
    providerMessageId: "1700.1", direction: "in", author: "Alice", text: "secret plans",
  });
  await connectSlack(api, { CSECRET: ["UALICE"] });
  const list = async () => (await (await fetch(`${api!.baseUrl}/api/workspaces/user/channels`)).json() as ListChannelsResponse).channels;
  const detail = () => fetch(`${api!.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("slack:CSECRET")}`);
  // No linked Slack account: the channel is hidden.
  expect(await list()).toEqual([]);
  expect((await detail()).status).toBe(404);
  // A linked member sees it. The unlinked answer above was not cached.
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UALICE", userId: "local-user" });
  expect((await list()).map((channel) => channel.key)).toEqual(["slack:CSECRET"]);
  expect((await detail()).status).toBe(200);
});

async function teamRuntime(a: TestApi) {
  const team = await createTeam(a.providers.db, { orgId: "local-org", name: "Secret", creatorUserId: "local-user" });
  return await ensureDefaultAssistantSession(a.providers, { type: "team", id: team.id }, { actorUserId: "local-user", orgId: "local-org" });
}

it("applies a private Slack thread's access to every route that addresses the thread", async () => {
  api = await bootTestApi();
  const root = await teamRuntime(api);
  const { session, sessionId } = await ensureAssistantExecution(api.providers, { type: "team", id: root.assistant.ownerId },
    { orgId: "local-org", actorUserId: "local-user" }, "slack:CROUTES:1700.1");
  const thread = await session.createThread("slack:CROUTES:1700.1");
  await recordChannelMessage(api.providers.db, {
    orgId: "local-org", sessionId, threadId: thread.id, channelKey: "slack:CROUTES", conversationKey: "slack:CROUTES:1700.1",
    providerMessageId: "1700.1", direction: "in", author: "Alice", text: "secret plans",
  });
  await connectSlack(api, { CROUTES: ["UROUTES"] });
  const base = `${api.baseUrl}/api/sessions/${sessionId}`;
  const json = { "content-type": "application/json" };
  const statuses = async () => [
    (await fetch(`${api!.baseUrl}/api/threads/${thread.id}`)).status,
    (await fetch(`${base}/threads/${thread.id}/channel-activity`)).status,
    (await fetch(`${base}/threads/${thread.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "Renamed" }) })).status,
    (await fetch(`${base}/threads/${thread.id}/resume`, { method: "POST" })).status,
    (await fetch(`${base}/threads`, { method: "POST", headers: json, body: JSON.stringify({ sourceThreadId: thread.id }) })).status,
  ];
  // Outside the channel, every path reads the thread as missing, and nothing is sent into it.
  expect(await statuses()).toEqual([404, 404, 404, 404, 404]);
  const send = await fetch(`${base}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "hi", threadId: thread.id }) });
  expect(send.status).toBe(404);
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UROUTES", userId: "local-user" });
  const [read, activity, rename, resume, fork] = await statuses();
  expect([read, activity, rename, resume]).toEqual([200, 200, 200, 200]);
  expect(fork).toBeLessThan(300);
});

it("keeps a public channel's threads readable after Slack disconnects, and a private channel's hidden", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await teamRuntime(api);
  const open = await session.createThread("slack:CKEEPPUB:1700.1");
  const closed = await session.createThread("slack:CKEEPPRIV:1700.1");
  await connectSlack(api, { CKEEPPRIV: ["USOMEONE"] });
  const threads = async () => ((await (await fetch(`${api!.baseUrl}/api/sessions/${sessionId}/threads`)).json()) as ListThreadsResponse).threads.map((t) => t.id);
  expect(await threads()).toEqual(expect.arrayContaining([open.id]));
  // Disconnect Slack and forget what this process remembered, as a restart would.
  vi.restoreAllMocks();
  await api.providers.engineCredentials.delete({ type: "org", id: "local-org" }, "slack");
  resetThreadAccessCache();
  const listed = await threads();
  expect(listed).toContain(open.id);
  expect(listed).not.toContain(closed.id);
});

it("leaves another member's helper thread out of a team channel's conversations and messages", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await teamRuntime(api);
  const theirs = await session.createThread("app-assistant:another-user");
  const shared = await session.createThread("web:shared");
  await connectSlack(api);
  for (const [thread, text] of [[theirs, "private draft"], [shared, "team update"]] as const) {
    await recordChannelMessage(api.providers.db, {
      orgId: "local-org", sessionId, threadId: thread.id, channelKey: "slack:CPUBLICENG", conversationKey: "slack:CPUBLICENG:1700.1",
      providerMessageId: `${text}-ts`, direction: "out", text,
    });
  }
  const owner = (await api.providers.db.execute(sql`SELECT owner_id FROM agent_sessions WHERE id = ${sessionId}`) as { rows: Array<{ owner_id: string }> }).rows[0]!.owner_id;
  const detail = await (await fetch(`${api.baseUrl}/api/workspaces/${owner}/channel?key=${encodeURIComponent("slack:CPUBLICENG")}`)).json() as ChannelDetailResponse;
  expect(detail.conversations.map((c) => c.threadId)).toEqual([shared.id]);
  expect(detail.messages.map((m) => m.text)).toEqual(["team update"]);
  for (const thread of [theirs, shared]) {
    await api.providers.db.execute(sql`insert into engine_entries (id, session_id, thread_id, entry_type, role, content, created_at)
      values (${`search-${thread.id}`}, ${sessionId}, ${thread.id}, 'message', 'user', 'searchable needle', 1)`);
  }
  const searchResponse = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/threads?q=needle`);
  expect(searchResponse.status).toBe(200);
  const matches = await searchResponse.json() as { threads: { id: string }[] };
  expect(matches.threads.map((t) => t.id)).toEqual([shared.id]);
  const list = await (await fetch(`${api.baseUrl}/api/workspaces/${owner}/channels`)).json() as ListChannelsResponse;
  expect(list.channels.find((c) => c.key === "slack:CPUBLICENG")).toMatchObject({ messageCount: 1, conversationCount: 1 });
});

it("routes a delegated child's pull request back to the thread that delegated it", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("web:delegating");
  await api.providers.db.insert(childWatches).values({
    childSessionId: "child-1", queueItemId: "q1", parentSessionId: sessionId, parentThreadId: thread.id,
    actorUserId: "local-user", orgId: "local-org", createdAt: 1,
  });
  const url = "https://github.com/acme/app/pull/77";
  await recordDelegatedPullRequest(api.providers.db, { sessionId: "child-1", threadId: "child-thread", url });
  expect((await threadForPullRequest(api.providers.db, "local-org", owner, url))?.key ?? null).toBe("web:delegating");
});

it("finds the thread that opened a pull request, and records the comment Valet posts there", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("web:pr-thread");
  const url = "https://github.com/acme/app/pull/12";
  await api.providers.db.insert(threadPullRequests).values({
    sessionId, threadId: thread.id, url, repo: "acme/app", number: 12, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1,
  });
  expect((await threadForPullRequest(api.providers.db, "local-org", owner, url))?.key ?? null).toBe("web:pr-thread");
  // An archived thread no list shows does not take the comment; it goes to the events thread.
  await api.providers.db.insert(sessionThreads).values({ id: thread.id, sessionId, createdAt: 1, archivedAt: 2 })
    .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: 2 } });
  expect((await threadForPullRequest(api.providers.db, "local-org", owner, url))?.key ?? null).toBeNull();
  await api.providers.db.update(sessionThreads).set({ archivedAt: null }).where(eq(sessionThreads.id, thread.id));
  expect((await threadForPullRequest(api.providers.db, "local-org", { type: "team", id: "other" }, url))?.key ?? null).toBeNull();

  await recordActionChannelMessage(api.providers.db, {
    actionId: "github.create_comment", status: "completed", orgId: "local-org", sessionId, threadId: thread.id,
    params: { owner: "acme", repo: "app", issueNumber: 12, body: "Pinned it." },
    result: { success: true, data: { id: 88, body: "Pinned it.", html_url: `${url}#issuecomment-88` } },
  });
  // Valet's own comment arrives as the person whose token posted it; the record marks it as Valet's.
  expect(await wasSentByValet(api.providers.db, "local-org", { channelKey: "github:acme/app#12", providerMessageId: "88" })).toBe(true);
  expect(await wasSentByValet(api.providers.db, "local-org", { channelKey: "github:acme/app#12", providerMessageId: "89" })).toBe(false);
  // An inline comment of a review Valet sent counts as Valet's own.
  expect(await wasSentByValet(api.providers.db, "local-org", { channelKey: "github:acme/app#12", providerMessageId: "90" }, ["88"])).toBe(true);
  // From the terminal: a comment by the id gh prints, a review (no id) as a timed mark.
  await recordTerminalPullRequestWrite(api.providers.db, { orgId: "local-org", sessionId, threadId: thread.id, kind: "pull_request_comment",
    url: "https://github.com/ACME/App/pull/12#issuecomment-901" });
  expect(await wasSentByValet(api.providers.db, "local-org", { channelKey: "github:acme/app#12", providerMessageId: "901" })).toBe(true);
  const key = "github:acme/app#12";
  const startedAt = Date.now() - 2_000;
  const completedAt = startedAt + 1_000;
  expect(await recentTerminalReview(api.providers.db, "local-org", key, startedAt, completedAt)).toBe(false);
  await recordTerminalPullRequestWrite(api.providers.db, {
    orgId: "local-org", sessionId, threadId: thread.id, kind: "review_submitted", startedAt,
  }, completedAt);
  // The command interval is inclusive at both boundaries.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, startedAt, completedAt)).toBe(true);
  expect(await recentTerminalReview(api.providers.db, "local-org", key, completedAt + 5_000, completedAt + 10_000)).toBe(true);
  // A human review before the command, even one close to it, is never Valet's.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, startedAt - 1, completedAt + 10_000)).toBe(false);
  // A person's review beyond completion clock skew is not Valet's.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, completedAt + 5_001, completedAt + 10_000)).toBe(false);
  // Without a submission time, a record in the last window counts.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, undefined, completedAt)).toBe(true);
  const detail = await (await fetch(`${api.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("github:acme/app#12")}`)).json() as ChannelDetailResponse;
  expect(detail.channel).toMatchObject({ provider: "github", name: "app #12", state: "open", url });
  expect(detail.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: "out", text: "Pinned it.", url: `${url}#issuecomment-88` }),
    expect.objectContaining({ direction: "out", text: "Posted a review from the terminal." }),
  ]));
});

it("includes execution channel activity while excluding executions from another member's helper", async () => {
  api = await bootTestApi();
  await connectSlack(api);
  const root = await teamRuntime(api);
  const teamOwner = { type: "team" as const, id: root.assistant.ownerId };
  const shared = await ensureAssistantExecution(api.providers, teamOwner,
    { orgId: "local-org", actorUserId: "local-user" }, "slack:CEXEC:1800.1");
  const hidden = await ensureAssistantExecution(api.providers, teamOwner,
    { orgId: "local-org", actorUserId: "local-user" }, "app-assistant:another-user");
  const visibleThread = await shared.session.createThread("slack:CEXEC:1800.1");
  // A public-looking child key must not bypass its private governing thread.
  const hiddenThread = await hidden.session.createThread("slack:CEXEC:1800.2");
  for (const [execution, thread, text] of [[shared, visibleThread, "execution reply"], [hidden, hiddenThread, "private execution draft"]] as const) {
    await recordChannelMessage(api.providers.db, {
      orgId: "local-org", sessionId: execution.sessionId, threadId: thread.id,
      channelKey: "slack:CEXEC", conversationKey: thread.key!, providerMessageId: thread.id,
      direction: "out", text,
    });
  }
  const prefix = `${api.baseUrl}/api/workspaces/${teamOwner.id}`;
  const list = await (await fetch(`${prefix}/channels`)).json() as ListChannelsResponse;
  expect(list.channels.find(channel => channel.key === "slack:CEXEC")).toMatchObject({ messageCount: 1 });
  const response = await fetch(`${prefix}/channel?key=slack:CEXEC`);
  expect(response.status).toBe(200);
  const detail = await response.json() as ChannelDetailResponse;
  expect(detail.messages).toEqual([expect.objectContaining({ sessionId: shared.sessionId, threadId: visibleThread.id, text: "execution reply" })]);
  expect(detail.conversations).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: shared.sessionId, threadId: visibleThread.id })]));
  expect(detail.conversations.some(conversation => conversation.sessionId === hidden.sessionId)).toBe(false);
});

it("retains the exact execution and thread when routing a private team's pull request", async () => {
  api = await bootTestApi();
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: "PR routing", creatorUserId: "local-user" });
  const owner = { type: "team", id: team.id } as const;
  const execution = await ensureAssistantExecution(api.providers, owner, { orgId: "local-org", actorUserId: "local-user" }, "app-assistant:local-user");
  const thread = await execution.session.ensureDefaultThread();
  const url = "https://github.com/acme/app/pull/819";
  await api.providers.db.insert(threadPullRequests).values({ sessionId: execution.sessionId, threadId: thread.id,
    url, repo: "acme/app", number: 819, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1 });
  expect(await threadForPullRequest(api.providers.db, "local-org", owner, url)).toEqual({
    sessionId: execution.sessionId, threadId: thread.id, key: "app-assistant:local-user",
  });
  expect(await threadForPullRequest(api.providers.db, "foreign-org", owner, url)).toBeNull();
});


it("does not hydrate archived-only executions in the active thread list", async () => {
  api = await bootTestApi();
  const root = await teamRuntime(api);
  const teamOwner = { type: "team", id: root.assistant.ownerId } as const;
  const archivedIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const execution = await ensureAssistantExecution(api.providers, teamOwner,
      { orgId: "local-org", actorUserId: "local-user" }, `workflow-report:archived-${i}`);
    const thread = await execution.session.ensureDefaultThread();
    archivedIds.push(execution.sessionId);
    await api.providers.db.insert(sessionThreads).values({ id: thread.id, sessionId: execution.sessionId, createdAt: 1, archivedAt: 2 });
  }
  const list = vi.spyOn(api.providers.engineStore, "listThreads");
  const defaults = vi.spyOn(api.providers.engineStore, "getSession");
  const url = `${api.baseUrl}/api/sessions/${root.sessionId}/threads`;
  expect((await fetch(url)).status).toBe(200);
  for (const id of archivedIds) {
    expect(list.mock.calls.some(call => call[0] === id)).toBe(false);
    expect(defaults.mock.calls.some(call => call[0] === id)).toBe(false);
  }
  const archived = await (await fetch(`${url}?archived=1`)).json() as ListThreadsResponse;
  expect(archived.threads.map(t => t.sessionId).sort()).toEqual(archivedIds.sort());
});
