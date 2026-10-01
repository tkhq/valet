import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { eq } from "drizzle-orm";
import { channelMessages, eventSubscriptions, sessionThreads, threadPullRequests } from "../schema/index.js";
import { recordActionChannelMessage, recordChannelMessage, threadKeyForPullRequest, wasSentByValet } from "../services/channel-messages.js";
import type { ChannelDetailResponse, ListChannelsResponse, ThreadChannelActivity, ListThreadsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const owner = { type: "user" as const, id: "local-user" };

async function runtime(a: TestApi) {
  return await ensureDefaultAssistantSession(a.providers, owner, { actorUserId: "local-user", orgId: "local-org" });
}

it("lists a workspace's Slack channel with its listener, thread, and messages, and links the thread back", async () => {
  api = await bootTestApi();
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
  const detail = await (await fetch(`${api.baseUrl}/api/workspaces/user/channel?key=${encodeURIComponent("github:acme/app#12")}`)).json() as ChannelDetailResponse;
  expect(detail.channel).toMatchObject({ provider: "github", name: "app #12", state: "open", url });
  expect(detail.messages).toEqual([expect.objectContaining({ direction: "out", text: "Pinned it.", url: `${url}#issuecomment-88` })]);
});
