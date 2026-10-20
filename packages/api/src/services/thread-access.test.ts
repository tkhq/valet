import { afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { linkIdentity } from "../channels/identity-links.js";
import { slackChannelPrivacy } from "../schema/index.js";
import { createTeam } from "./teams.js";
import { cachedThreadVisibility, governingThreadKeySql, isAssistantConversationOf, privateThreadOwner, resetThreadAccessCache, runOriginVisible, sharedWithWholeTeamSql, SLACK_CHANNELS_METADATA_KEY, threadReadAccess, threadRef, threadSlackChannelsSql, threadVisibility, visibleThreadIds } from "./thread-access.js";
import type { WireEvent } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

/** Answers Slack's channel checks: `members` lists each private channel's members. */
async function connectSlack(a: TestApi, members: Record<string, string[]>) {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const body = url.pathname.endsWith("conversations.members")
      ? { ok: true, members: members[channel] ?? [] }
      : { ok: true, channel: { name: channel.toLowerCase(), is_private: members[channel] !== undefined } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

const team = { type: "team" as const, id: "team-1" };
const ref = (key: string) => ({ id: key, key });

it("keeps a workflow started in a private execution visible only to its originating member", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Private workflow", creatorUserId: "local-user" });
  const execution = await ensureAssistantExecution(p, { type: "team", id: team.id },
    { orgId: "local-org", actorUserId: "local-user" }, "app-assistant:local-user");
  const thread = await execution.session.ensureDefaultThread();
  const run = { ownerType: "team", actorUserId: "local-user",
    origin: { assistantSessionId: execution.sessionId, threadId: thread.id } };
  expect(await runOriginVisible(p, { orgId: "local-org", userId: "local-user" }, run)).toBe(true);
  expect(await runOriginVisible(p, { orgId: "local-org", userId: "test-member" }, run)).toBe(false);
  expect(await runOriginVisible(p, { orgId: "local-org", userId: undefined }, run)).toBe(false);
});

it("lets a thread read only what its audience may see", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CREADPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "member" });
  const canRead = threadReadAccess(api.providers);
  const read = (reader: string, target: string) => canRead({ owner: team, orgId: "local-org", reader: ref(reader), target: ref(target) });

  // A shared thread reads shared threads and public channels, never a private one.
  expect(await read("web:default", "slack:CREADPUB:1.1")).toBe(true);
  expect(await read("web:default", "slack:CREADPRIV:1.1")).toBe(false);
  expect(await read("web:default", "slack:CREADPRIV")).toBe(false);
  expect(await read("slack:CREADPRIV", "web:shared")).toBe(false);
  expect(await read("web:default", "app-assistant:member")).toBe(false);
  // An editor conversation from before per-person keys names nobody, so nobody else reads it.
  expect(await read("web:default", "workflow:wf_legacy")).toBe(false);
  // A private channel's thread reads its own channel.
  expect(await read("slack:CREADPRIV:2.2", "slack:CREADPRIV:1.1")).toBe(true);
  // People outside the team read Slack, Telegram, and GitHub threads, so those
  // threads read no team web thread. A Slack thread still reads public channels.
  expect(await read("slack:CREADPRIV:2.2", "web:shared")).toBe(false);
  for (const reader of ["slack-events:CREADPRIV", "slack-events:CREADPRIV:run-1"]) {
    expect(await read(reader, "web:shared")).toBe(false);
    expect(await read(reader, "slack:CREADPRIV:1.1")).toBe(true);
    expect(await read(reader, "slack:CREADPUB:1.1")).toBe(true);
  }
  expect(await read("slack:CREADPUB:2.2", "web:shared")).toBe(false);
  expect(await read("slack:CREADPRIV:2.2", "slack:CREADPUB:1.1")).toBe(true);
  expect(await read("telegram:dm:99", "web:shared")).toBe(false);
  expect(await read("github:acme/app#12", "slack:CREADPUB:1.1")).toBe(false);
  expect(await read("github:acme/app#12", "github:acme/app#12")).toBe(true);
  // A helper thread reads what its person may see.
  expect(await read("app-assistant:member", "slack:CREADPRIV:1.1")).toBe(true);
  expect(await read("app-assistant:outsider", "slack:CREADPRIV:1.1")).toBe(false);
  expect(await read("app-assistant:outsider", "app-assistant:member")).toBe(false);
  // Each Ask Valet conversation adds its own id after the person.
  expect(await read("app-assistant:member:c1", "slack:CREADPRIV:1.1")).toBe(true);
  expect(await read("app-assistant:member:c1", "app-assistant:member:c2")).toBe(true);
  expect(await read("app-assistant:outsider:c1", "app-assistant:member:c2")).toBe(false);
  // A personal runtime has one person: it reads everything.
  expect(await canRead({ owner: { type: "user", id: "member" }, orgId: "local-org", reader: ref("web:default"), target: ref("app-assistant:x") })).toBe(true);
});

it("shares a team thread with the whole team only when nothing narrows it", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(slackChannelPrivacy).values([
    { orgId: "local-org", channelId: "CSHAREPUB", isPrivate: false, checkedAt: Date.now() },
    { orgId: "local-org", channelId: "CSHAREPRIV", isPrivate: true, checkedAt: 1 },
  ]);
  const shared = async (key: string | null) => {
    const result = await api!.providers.db.execute(sql`SELECT ${sharedWithWholeTeamSql("local-org", sql`${key}::text`)} AS shared`) as { rows: Array<{ shared: boolean }> };
    return result.rows[0]?.shared;
  };
  expect(await shared(null)).toBe(true);
  expect(await shared("web:default")).toBe(true);
  expect(await shared("slack:CSHAREPUB:1.1")).toBe(true);
  expect(await shared("slack:CSHAREPRIV:1.1")).toBe(false);
  // A channel's events thread follows the channel.
  expect(await shared("slack-events:CSHAREPUB")).toBe(true);
  expect(await shared("slack-events:CSHAREPRIV")).toBe(false);
  // So does a workflow run that channel's event started (`workflowRunThreadKey`).
  expect(await shared("slack-events:CSHAREPRIV:workflow:run_1")).toBe(false);
  expect(await shared("slack-events:CSHAREPUB:workflow:run_1")).toBe(true);
  // A channel never classified waits until a thread list classifies it.
  expect(await shared("slack:CSHARENEW:1.1")).toBe(false);
  expect(await shared("app-assistant:someone")).toBe(false);
  expect(await shared("workflow:wf-1:someone")).toBe(false);
});

it("streams a private Slack thread's events only to the channel's members", async () => {
  api = await bootTestApi();
  const created = await createTeam(api.providers.db, { orgId: "local-org", name: "Stream", creatorUserId: "local-user" });
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: created.id }, { actorUserId: "local-user", orgId: "local-org" });
  const unresolved = await session.createThread("web:unresolved");
  const hidden = await session.createThread("slack:CSTREAM:1700.1");
  const findThread = session.threadById.bind(session);
  const getThread = api.providers.engineStore.getThread.bind(api.providers.engineStore);
  const liveLookup = vi.spyOn(session, "threadById").mockImplementation((id) => id === unresolved.id ? null : findThread(id));
  const storedLookup = vi.spyOn(api.providers.engineStore, "getThread").mockImplementation((sid, id) => id === unresolved.id ? Promise.resolve(null) : getThread(sid, id));
  const shown = await session.createThread("web:shared");
  await connectSlack(api, { CSTREAM: ["USTREAM"] });

  const frames: WireEvent[] = [];
  const ws = new WebSocket(`${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=0`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no model.state for the shared thread; saw ${frames.map((f) => f.type).join(", ")}`)), 5_000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as WireEvent;
      frames.push(frame);
      if (frame.type === "model.state" && frame.threadId === shown.id) { clearTimeout(timeout); resolve(); }
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("ws error")); };
  });
  // Seeds come out in thread order through one chain, so every frame for the
  // hidden thread would have arrived by now.
  expect(frames.some((frame) => "threadId" in frame && frame.threadId === unresolved.id)).toBe(false);
  liveLookup.mockRestore();
  storedLookup.mockRestore();
  // Missing metadata must not cache an authorization result. Once the public
  // thread resolves, its next frame is admitted on this same connection.
  const received = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("resolved thread frame was not delivered")), 5_000);
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "model.state" && frame.threadId === unresolved.id) { clearTimeout(timeout); resolve(); }
    });
  });
  await api.providers.eventStream.append({
    sessionId, threadId: unresolved.id, userId: "local-user", timestamp: Date.now(),
    event: { type: "model_state", threadId: unresolved.id, model: "anthropic/claude-haiku-4-5", queueItemId: "resolved-queue" },
  }, "resolved-thread");
  await received;
  ws.close();
  const threadIds = frames.flatMap((frame) => "threadId" in frame && typeof frame.threadId === "string" ? [frame.threadId] : []);
  expect(threadIds).toContain(shown.id);
  expect(threadIds).not.toContain(hidden.id);
});

it("shows a person's helper and editor threads only to that person, and a legacy editor key to nobody", async () => {
  api = await bootTestApi();
  const visible = threadVisibility(api.providers, { ownerType: "team" }, { orgId: "local-org", userId: "member" });
  expect(await visible("app-assistant:member")).toBe(true);
  expect(await visible("workflow:wf_1:member")).toBe(true);
  expect(await visible("app-assistant:other")).toBe(false);
  expect(await visible("app-assistant:member:c1")).toBe(true);
  expect(await visible("app-assistant:other:c1")).toBe(false);
  expect(await visible("app-assistant:")).toBe(false);
  expect(await visible("workflow:wf_1:other")).toBe(false);
  expect(await visible("workflow:wf_legacy")).toBe(false);
  expect(await visible("web:default")).toBe(true);
  // A personal runtime has one person, who sees every thread.
  expect(await threadVisibility(api.providers, { ownerType: "user" }, { orgId: "local-org", userId: "member" })("workflow:wf_legacy")).toBe(true);
});

it("reads the person from a helper key with or without a conversation id", () => {
  expect(privateThreadOwner("app-assistant:member:c1")).toBe("member");
  expect(privateThreadOwner("app-assistant:member")).toBe("member");
  expect(privateThreadOwner("app-assistant:")).toBeUndefined();
  expect(isAssistantConversationOf("app-assistant:member:c1", "member")).toBe(true);
  expect(isAssistantConversationOf("app-assistant:member", "member")).toBe(true);
  expect(isAssistantConversationOf("app-assistant:member2:c1", "member")).toBe(false);
  expect(isAssistantConversationOf("app-assistant:memberx", "member")).toBe(false);
  expect(isAssistantConversationOf("web:app-assistant:member", "member")).toBe(false);
});

it("judges a child session's threads by the thread that started it", async () => {
  api = await bootTestApi();
  const { db } = api.providers;
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at) VALUES
    ('thr-p', 'sess-p', 'app-assistant:member', 'idle', 'steer', 1, 1),
    ('thr-c', 'sess-c', 'web:default', 'idle', 'steer', 1, 1),
    ('thr-g', 'sess-g', 'web:default', 'idle', 'steer', 1, 1)`);
  await db.execute(sql`INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, parent_session_id, parent_thread_id, created_at, updated_at) VALUES
    ('sess-c', 'team', 'team-1', 'member', 'local-org', '/', 'child', 'running', 'sess-p', 'thr-p', 1, 1),
    ('sess-g', 'team', 'team-1', 'member', 'local-org', '/', 'child', 'running', 'sess-c', 'thr-c', 1, 1)`);
  for (const session of ["sess-c", "sess-g"]) {
    const asMember = threadVisibility(api.providers, { ownerType: "team", id: session }, { orgId: "local-org", userId: "member" });
    const asOther = threadVisibility(api.providers, { ownerType: "team", id: session }, { orgId: "local-org", userId: "other" });
    expect(await asMember("web:default")).toBe(true);
    expect(await asOther("web:default")).toBe(false);
  }
  // A thread of the runtime itself decides by its own key.
  expect(await threadVisibility(api.providers, { ownerType: "team", id: "sess-p" }, { orgId: "local-org", userId: "other" })("web:default")).toBe(true);
});

it("keeps a child private when the thread that started it is gone", async () => {
  api = await bootTestApi();
  const { db } = api.providers;
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at) VALUES
    ('thr-o', 'sess-o', 'web:default', 'idle', 'steer', 1, 1)`);
  await db.execute(sql`INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, parent_session_id, parent_thread_id, created_at, updated_at) VALUES
    ('sess-o', 'team', 'team-1', 'member', 'local-org', '/', 'child', 'running', 'sess-gone', 'thr-gone', 1, 1)`);
  for (const userId of ["member", "other"]) {
    expect(await threadVisibility(api.providers, { ownerType: "team", id: "sess-o" }, { orgId: "local-org", userId })("web:default")).toBe(false);
  }
  // No thread at all is still the workspace's shared default.
  const result = await db.execute(sql`SELECT ${sharedWithWholeTeamSql("local-org", governingThreadKeySql(sql`NULL`, sql`NULL`))} AS shared`) as { rows: Array<{ shared: boolean }> };
  expect(result.rows[0]?.shared).toBe(true);
});

it("hides a channel never classified when Slack cannot answer", async () => {
  api = await bootTestApi();
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  for (const error of ["ratelimited", "channel_not_found"]) {
    resetThreadAccessCache();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error }), { headers: { "content-type": "application/json" } }));
    for (const userId of ["outsider", undefined]) {
      expect(await threadVisibility(api.providers, { ownerType: "team" }, { orgId: "local-org", userId })("slack:CNEVERSEEN:1.1")).toBe(false);
    }
    expect(await threadReadAccess(api.providers)({ owner: team, orgId: "local-org", reader: ref("web:default"), target: ref("slack:CNEVERSEEN:1.1") })).toBe(false);
    vi.restoreAllMocks();
  }
  // Once Slack answers, a public channel shows.
  await connectSlack(api, {});
  resetThreadAccessCache();
  expect(await threadVisibility(api.providers, { ownerType: "team" }, { orgId: "local-org", userId: "outsider" })("slack:CNEVERSEEN:1.1")).toBe(true);
});

it("keeps a DM and a group DM to their members", async () => {
  api = await bootTestApi();
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UINDM", userId: "member" });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const body = url.pathname.endsWith("conversations.members")
      ? { ok: true, members: ["UINDM", "UBOT"] }
      : { ok: true, channel: channel.startsWith("D") ? { is_im: true } : { is_private: true, is_mpim: true } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  for (const key of ["slack:G0MPIM:1700.1", "slack:D0DIRECT:1700.1", "slack:G0MPIM", "slack:D0DIRECT"]) {
    const visibleTo = (userId: string | undefined) => threadVisibility(api!.providers, { ownerType: "team" }, { orgId: "local-org", userId })(key);
    expect(await visibleTo("member")).toBe(true);
    expect(await visibleTo("outsider-no-slack-link")).toBe(false);
    expect(await visibleTo(undefined)).toBe(false);
    expect(await threadReadAccess(api.providers)({ owner: team, orgId: "local-org", reader: ref("web:default"), target: ref(key) })).toBe(false);
  }
  // Neither enters content the whole team sees at once.
  const shared = await api.providers.db.execute(sql`SELECT ${sharedWithWholeTeamSql("local-org", sql`${"slack:D0DIRECT:1700.1"}::text`)} AS shared`) as { rows: Array<{ shared: boolean }> };
  expect(shared.rows[0]?.shared).toBe(false);
});

it("rechecks a stale public answer, and keeps it when Slack cannot answer", async () => {
  api = await bootTestApi();
  await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
  const visible = () => threadVisibility(api!.providers, { ownerType: "team" }, { orgId: "local-org", userId: "outsider" })("slack:CWASPUBLIC:1.1");
  await api.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CWASPUBLIC", isPrivate: false, checkedAt: Date.now() - 60 * 60_000 });
  // Slack is down: the last known "public" stands, so the thread stays readable.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { headers: { "content-type": "application/json" } }));
  expect(await visible()).toBe(true);
  // Slack answers that the channel is now private: the stale answer is replaced and the thread hides.
  vi.restoreAllMocks();
  resetThreadAccessCache();
  await connectSlack(api, { CWASPUBLIC: ["USOMEONE"] });
  expect(await visible()).toBe(false);
});

it("denies unresolved source pairs instead of treating them as shared", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  await db.execute(sql`INSERT INTO engine_threads(id,session_id,key,status,queue_mode,created_at,updated_at)
    VALUES ('public','source','web:shared','idle','steer',1,1),
      ('private','source','app-assistant:someone-else','idle','steer',1,1)`);
  const sources = ["public", "private", "missing"].map(threadId => ({ sessionId: "source", threadId }));
  const viewer = { orgId: "local-org", userId: "local-user" };
  expect(await visibleThreadIds(api.providers, { ownerType: "team" }, viewer, sources)).toEqual(new Set(["source:public"]));
  await db.execute(sql`DELETE FROM engine_threads WHERE session_id='source'`);
  expect(await visibleThreadIds(api.providers, { ownerType: "team" }, viewer, sources)).toEqual(new Set());
});

/**
 * Rule threads (`sub:`, `subject:`, `schedule:`) carry no channel in their
 * key. A delivery records its Slack channel on the thread
 * (`metadata.slackChannels`), and the read gate follows that content.
 */
it("gates a team rule thread by the private channel content it holds", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await connectSlack(api, { CRULEPRIV: ["UMEMBER"], CRULEOTHER: ["UOTHER"] });
  await linkIdentity(p.db, { provider: "slack", externalId: "UMEMBER", userId: "member" });
  await linkIdentity(p.db, { provider: "slack", externalId: "UOUT", userId: "outsider" });
  const t = await createTeam(p.db, { orgId: "local-org", name: "Rule threads", creatorUserId: "local-user" });
  // A team rule with the `own` policy delivers into an execution keyed `sub:<rule>`.
  const execution = await ensureAssistantExecution(p, { type: "team", id: t.id }, { orgId: "local-org", actorUserId: "local-user" }, "sub:rule-1");
  const thread = await execution.session.createThread("sub:rule-1");
  await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, "CRULEPRIV");
  const session = { ownerType: "team", id: execution.sessionId };
  const sees = (userId: string) => threadVisibility(p, session, { orgId: "local-org", userId })(threadRef(thread));
  expect(await sees("member")).toBe(true);
  expect(await sees("outsider")).toBe(false);
  // A list of threads applies the same gate from the store.
  const listed = (userId: string) => visibleThreadIds(p, { ownerType: "team" }, { orgId: "local-org", userId }, [{ sessionId: execution.sessionId, threadId: thread.id }]);
  expect([...await listed("member")]).toEqual([`${execution.sessionId}:${thread.id}`]);
  expect([...await listed("outsider")]).toEqual([]);
  // Content from two private channels needs membership in both.
  await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, "CRULEOTHER");
  expect(await sees("member")).toBe(false);
  // A team web thread may not read it, so the agent cannot repeat it there.
  const canRead = threadReadAccess(p);
  expect(await canRead({ owner: team, orgId: "local-org", reader: ref("web:default"), target: { id: thread.id, key: "sub:rule-1" } })).toBe(false);
  // Content every member sees leaves it out.
  await p.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CRULEPUB", isPrivate: false, checkedAt: Date.now() }).onConflictDoNothing();
  const shared = await p.db.execute(sql`SELECT ${sharedWithWholeTeamSql("local-org", sql`'sub:rule-1'::text`,
    threadSlackChannelsSql(sql`${execution.sessionId}`, sql`${thread.id}`))} AS shared`) as { rows: Array<{ shared: boolean }> };
  expect(shared.rows[0]?.shared).toBe(false);
});

it("gates a Slack subject thread by its channel and leaves a thread without Slack content open", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await connectSlack(api, { CSUBJPRIV: ["UMEMBER"] });
  await linkIdentity(p.db, { provider: "slack", externalId: "UMEMBER", userId: "member" });
  await linkIdentity(p.db, { provider: "slack", externalId: "UOUT", userId: "outsider" });
  const sees = (userId: string, thread: string | { key: string; metadata?: Record<string, unknown> }) =>
    threadVisibility(p, { ownerType: "team" }, { orgId: "local-org", userId })(thread);
  expect(await sees("member", "subject:slack:T001/CSUBJPRIV")).toBe(true);
  expect(await sees("outsider", "subject:slack:T001/CSUBJPRIV")).toBe(false);
  // A rule thread with no Slack content is open to the team.
  expect(await sees("outsider", { key: "sub:rule-2", metadata: {} })).toBe(true);
  expect(await sees("outsider", "schedule:sched-1")).toBe(true);
  expect(await sees("outsider", "subject:github:acme/api#12")).toBe(true);
  // The shared-content SQL reads the subject key's channel too.
  await p.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CSUBJPUB", isPrivate: false, checkedAt: Date.now() });
  const shared = async (key: string) => {
    const result = await p.db.execute(sql`SELECT ${sharedWithWholeTeamSql("local-org", sql`${key}::text`)} AS shared`) as { rows: Array<{ shared: boolean }> };
    return result.rows[0]?.shared;
  };
  expect(await shared("subject:slack:T001/CSUBJPUB")).toBe(true);
  expect(await shared("subject:slack:T001/CSUBJPRIV")).toBe(false);
});

it("stops showing a live thread's frames once a delivery records a private channel on it", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await connectSlack(api, { CLIVEPRIV: ["UMEMBER"] });
  await linkIdentity(p.db, { provider: "slack", externalId: "UOUT", userId: "outsider" });
  const t = await createTeam(p.db, { orgId: "local-org", name: "Live stream", creatorUserId: "local-user" });
  const execution = await ensureAssistantExecution(p, { type: "team", id: t.id }, { orgId: "local-org", actorUserId: "local-user" }, "sub:rule-live");
  const thread = await execution.session.createThread("sub:rule-live");
  const visible = threadVisibility(p, { ownerType: "team", id: execution.sessionId }, { orgId: "local-org", userId: "outsider" });
  // The socket's frame check, with a TTL far longer than the test.
  const shown = cachedThreadVisibility(visible, (id) => id === thread.id ? threadRef(thread) : undefined,
    async () => undefined, 60 * 60_000);
  expect(await shown(thread.id)).toBe(true);
  // A private-channel delivery lands in the thread while the socket is open.
  await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, "CLIVEPRIV");
  expect(await shown(thread.id)).toBe(false);
});

it("stops showing a child's frames once its parent thread records a private channel, before the TTL", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await connectSlack(api, { CPARENTPRIV: ["UMEMBER"] });
  await linkIdentity(p.db, { provider: "slack", externalId: "UOUT", userId: "outsider" });
  const t = await createTeam(p.db, { orgId: "local-org", name: "Inherited", creatorUserId: "local-user" });
  // A team execution is a child of its governing thread in the assistant's root session.
  const execution = await ensureAssistantExecution(p, { type: "team", id: t.id }, { orgId: "local-org", actorUserId: "local-user" }, "sub:rule-parent");
  const parentLink = await p.db.execute(sql`SELECT parent_session_id, parent_thread_id FROM engine_sessions WHERE id = ${execution.sessionId}`) as {
    rows: Array<{ parent_session_id: string | null; parent_thread_id: string | null }>;
  };
  const parent = parentLink.rows[0];
  if (!parent?.parent_session_id || !parent.parent_thread_id) throw new Error("expected the execution to link its governing thread");
  const parentThread = p.engineHost.liveSession(parent.parent_session_id)?.threadById(parent.parent_thread_id);
  if (!parentThread) throw new Error("expected the governing thread to be live");
  const child = await execution.session.createThread("sub:rule-parent");
  const liveThread = (sessionId: string, threadId: string) => {
    const live = p.engineHost.liveSession(sessionId)?.threadById(threadId);
    return live ? threadRef(live) : undefined;
  };
  const visible = threadVisibility(p, { ownerType: "team", id: execution.sessionId }, { orgId: "local-org", userId: "outsider" }, { liveThread });
  const shown = cachedThreadVisibility(visible, (id) => id === child.id ? threadRef(child) : undefined, async () => undefined, 60 * 60_000);
  expect(await shown(child.id)).toBe(true);
  // A private-channel delivery lands in the parent while the child's socket is open.
  await parentThread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, "CPARENTPRIV");
  expect(await shown(child.id)).toBe(false);
});
