import { afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { linkIdentity } from "../channels/identity-links.js";
import { slackChannelPrivacy } from "../schema/index.js";
import { createTeam } from "./teams.js";
import { governingThreadKeySql, resetThreadAccessCache, sharedWithWholeTeamSql, threadReadAccess, threadVisibility } from "./thread-access.js";
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

it("lets a thread read only what its audience may see", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CREADPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "member" });
  const canRead = threadReadAccess(api.providers);
  const read = (reader: string, target: string) => canRead({ owner: team, orgId: "local-org", reader: ref(reader), target: ref(target) });

  // A shared thread reads shared threads and public channels, never a private one.
  expect(await read("web:default", "slack:CREADPUB:1.1")).toBe(true);
  expect(await read("web:default", "slack:CREADPRIV:1.1")).toBe(false);
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
  // A personal runtime has one person: it reads everything.
  expect(await canRead({ owner: { type: "user", id: "member" }, orgId: "local-org", reader: ref("web:default"), target: ref("app-assistant:x") })).toBe(true);
});

it("shares a team thread with the whole team only when nothing narrows it", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(slackChannelPrivacy).values([
    { orgId: "local-org", channelId: "CSHAREPUB", isPrivate: false, checkedAt: 1 },
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
  const hidden = await session.createThread("slack:CSTREAM:1700.1");
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
  expect(await visible("workflow:wf_1:other")).toBe(false);
  expect(await visible("workflow:wf_legacy")).toBe(false);
  expect(await visible("web:default")).toBe(true);
  // A personal runtime has one person, who sees every thread.
  expect(await threadVisibility(api.providers, { ownerType: "user" }, { orgId: "local-org", userId: "member" })("workflow:wf_legacy")).toBe(true);
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
  for (const key of ["slack:G0MPIM:1700.1", "slack:D0DIRECT:1700.1"]) {
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
