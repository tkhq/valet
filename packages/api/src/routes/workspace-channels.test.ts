import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { eq } from "drizzle-orm";
import { channelMessages, childWatches, eventSubscriptions, sessionThreads, threadPullRequests } from "../schema/index.js";
import { linkIdentity } from "../channels/identity-links.js";
import { recordDelegatedPullRequest } from "../services/thread-read-state.js";
import { createTeam } from "../services/teams.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import { recentTerminalReview, recordActionChannelMessage, recordChannelMessage, recordTerminalPullRequestWrite, threadKeyForPullRequest, wasSentByValet } from "../services/channel-messages.js";
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

it("hides a team runtime's private Slack thread from members outside that channel", async () => {
  api = await bootTestApi();
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Secret", creatorUserId: "local-user" });
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: "local-user", orgId: "local-org" });
  const thread = await session.createThread("slack:CTEAMSECRET:1700.1");
  await connectSlack(api, { CTEAMSECRET: ["UTEAMMATE"] });
  const threads = async () => ((await (await fetch(`${api!.baseUrl}/api/sessions/${sessionId}/threads`)).json()) as ListThreadsResponse).threads.map((t) => t.id);
  const messages = () => fetch(`${api!.baseUrl}/api/sessions/${sessionId}/messages?threadId=${thread.id}`);
  expect(await threads()).not.toContain(thread.id);
  expect((await messages()).status).toBe(404);
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UTEAMMATE", userId: "local-user" });
  expect(await threads()).toContain(thread.id);
  expect((await messages()).status).toBe(200);
});

async function teamRuntime(a: TestApi) {
  const team = await createTeam(a.providers.db, { orgId: "local-org", name: "Secret", creatorUserId: "local-user" });
  return await ensureDefaultAssistantSession(a.providers, { type: "team", id: team.id }, { actorUserId: "local-user", orgId: "local-org" });
}

it("applies a private Slack thread's access to every route that addresses the thread", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await teamRuntime(api);
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

it("keeps another member's helper thread private in the API", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await teamRuntime(api);
  const theirs = await session.createThread("app-assistant:another-user");
  const mine = await session.createThread("app-assistant:local-user");
  expect((await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${theirs.id}`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/threads/${theirs.id}`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${mine.id}`)).status).toBe(200);
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
  expect(await threadKeyForPullRequest(api.providers.db, "local-org", owner, url)).toBe("web:delegating");
});

it("finds the thread that opened a pull request, and records the comment Valet posts there", async () => {
  api = await bootTestApi();
  const { session, sessionId } = await runtime(api);
  const thread = await session.createThread("web:pr-thread");
  const url = "https://github.com/acme/app/pull/12";
  await api.providers.db.insert(threadPullRequests).values({
    sessionId, threadId: thread.id, url, repo: "acme/app", number: 12, state: "open", createdAt: 1, updatedAt: 1, checkedAt: 1,
  });
  expect(await threadKeyForPullRequest(api.providers.db, "local-org", owner, url)).toBe("web:pr-thread");
  // An archived thread no list shows does not take the comment; it goes to the events thread.
  await api.providers.db.insert(sessionThreads).values({ id: thread.id, sessionId, createdAt: 1, archivedAt: 2 })
    .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: 2 } });
  expect(await threadKeyForPullRequest(api.providers.db, "local-org", owner, url)).toBeNull();
  await api.providers.db.update(sessionThreads).set({ archivedAt: null }).where(eq(sessionThreads.id, thread.id));
  expect(await threadKeyForPullRequest(api.providers.db, "local-org", { type: "team", id: "other" }, url)).toBeNull();

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
  expect(await recentTerminalReview(api.providers.db, "local-org", key, Date.now())).toBe(false);
  const submitted = Date.now();
  await recordTerminalPullRequestWrite(api.providers.db, { orgId: "local-org", sessionId, threadId: thread.id, kind: "review_submitted" });
  // Valet's own review was submitted just before its record.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, submitted)).toBe(true);
  // A person's review submitted after the record is not Valet's.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, Date.now() + 10_000)).toBe(false);
  // Without a submission time, a record in the last window counts.
  expect(await recentTerminalReview(api.providers.db, "local-org", key, undefined)).toBe(true);
  const detail = await (await fetch(`${api.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("github:acme/app#12")}`)).json() as ChannelDetailResponse;
  expect(detail.channel).toMatchObject({ provider: "github", name: "app #12", state: "open", url });
  expect(detail.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: "out", text: "Pinned it.", url: `${url}#issuecomment-88` }),
    expect.objectContaining({ direction: "out", text: "Posted a review from the terminal." }),
  ]));
});
