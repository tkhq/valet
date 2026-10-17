import { afterEach, expect, it, vi } from "vitest";
import slackPlugin from "@valet/plugin-slack/plugin";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import type { EventMatchSpec, Wakeup } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { eventDeliveries, eventSubscriptions, events, followedThreads, workflowSchedules } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import type {
  ListPresencePlacesResponse, ListThreadFeedersResponse, PresencePlaceDetailResponse, PresencePlaceWire,
} from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

const ORG = "local-org";
const USER = "local-user";
const DAY = 24 * 60 * 60 * 1000;

async function boot(): Promise<TestApi> {
  return await bootTestApi({ plugins: [slackPlugin, githubPlugin, linearPlugin] });
}

/** Connects the org Slack bot for team `T1` and answers Slack's channel
 * checks: `members` lists each private channel's members; any other channel
 * is public. */
async function connectSlack(a: TestApi, members: Record<string, string[]> = {}) {
  await a.providers.engineCredentials.save({ type: "org", id: ORG }, "slack",
    { type: "oauth2", accessToken: "xoxb-test", metadata: { teamId: "T1" } });
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

interface RuleSeed {
  id: string;
  ownerType?: "user" | "team" | "org";
  ownerId?: string;
  name?: string;
  eventKeys: string[];
  filters?: unknown[];
  target?: Record<string, unknown>;
}

async function rule(a: TestApi, seed: RuleSeed) {
  await a.providers.db.insert(eventSubscriptions).values({
    id: seed.id, orgId: ORG, ownerType: seed.ownerType ?? "user", ownerId: seed.ownerId ?? USER, name: seed.name ?? seed.id,
    eventKeys: seed.eventKeys, filters: seed.filters ?? [], target: seed.target ?? { kind: "assistant" },
    enabled: true, createdBy: USER, createdAt: 1, updatedAt: 1,
  });
}

async function event(a: TestApi, seed: { id: string; service: string; key: string; subjects: string[]; at: number; ruleId: string; refs?: Record<string, string> }) {
  await a.providers.db.insert(events).values({
    id: seed.id, orgId: ORG, service: seed.service, eventKey: seed.key, dedupeKey: seed.id, refs: seed.refs ?? {},
    summary: `Event ${seed.id}`, payload: {}, occurredAt: seed.at, receivedAt: seed.at, subjects: seed.subjects,
  });
  await a.providers.db.insert(eventDeliveries).values({
    id: `d-${seed.id}`, eventId: seed.id, subscriptionId: seed.ruleId, status: "delivered", nextAttemptAt: seed.at, createdAt: seed.at,
  });
}

function waiter(over: Partial<Wakeup> & Pick<Wakeup, "id" | "sessionId" | "threadId">): Wakeup {
  const eventMatch: EventMatchSpec = { clauses: [{ key: "slack.message" }], once: false, self: [] };
  return {
    kind: "event", status: "running", reason: "Watching", logOffset: 0, logTail: "", eventCount: 0,
    createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + DAY, subjects: [], eventMatch, eventBuffer: [],
    ...over,
  };
}

async function places(a: TestApi, scope: string): Promise<PresencePlaceWire[]> {
  const res = await fetch(`${a.baseUrl}/api/presence/places?scope=${encodeURIComponent(scope)}`);
  expect(res.status).toBe(200);
  return (await res.json() as ListPresencePlacesResponse).places;
}

function bySubject(rows: PresencePlaceWire[]): Map<string, PresencePlaceWire> {
  return new Map(rows.map((row) => [row.subject, row]));
}

it("lists the workspace's places by service, with parents, counts, and the 30-day activity window", async () => {
  api = await boot();
  await connectSlack(api);
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  const team = await createTeam(api.providers.db, { orgId: ORG, name: "SRE", creatorUserId: USER });

  await rule(api, { id: "r-inc", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "C900", label: "incidents" }] });
  await rule(api, { id: "r-two", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "in", value: ["C900", "C901"] }] });
  await rule(api, { id: "r1", eventKeys: ["github.pull_request_review.submitted"], filters: [{ field: "repo", op: "eq", value: "Acme/API" }] });
  await rule(api, { id: "r-lin", eventKeys: ["linear.Issue.*"], filters: [{ field: "team", op: "eq", value: "ENG" }] });
  await rule(api, { id: "r-team", ownerType: "team", ownerId: team.id, eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "C777" }] });

  const subjectThread = await session.createThread("subject:github:acme/api#12");
  const watching = await session.createThread("web:watching");
  const ended = await session.createThread("web:ended");
  await api.providers.engineStore.createWakeup(waiter({ id: "w-run", sessionId, threadId: watching.id, subjects: ["slack:T1/C900/1700.1"] }));
  await api.providers.engineStore.createWakeup(waiter({ id: "w-done", sessionId, threadId: ended.id, status: "done", subjects: ["slack:T1/C900"] }));

  await api.providers.db.insert(followedThreads).values({
    id: "f-1", orgId: ORG, channelType: "slack", channelId: "C902", threadTs: "1700.5", ownerType: "user", ownerId: USER,
    createdBy: USER, createdAt: 5, lastActivityAt: 5_000, sessionId, threadId: watching.id,
  });

  const now = Date.now();
  await event(api, { id: "e-in", service: "linear", key: "linear.Issue.update", subjects: ["linear:team/ENG", "linear:ENG-42"], at: now - DAY, ruleId: "r-lin" });
  await event(api, { id: "e-old", service: "linear", key: "linear.Issue.update", subjects: ["linear:team/ENG", "linear:ENG-7"], at: now - 31 * DAY, ruleId: "r-lin" });
  await event(api, { id: "e-team", service: "slack", key: "slack.app_mention", subjects: ["slack:T1", "slack:T1/C777"], at: now - DAY, ruleId: "r-team" });

  const rows = await places(api, "user");
  expect(rows.map((row) => row.service)).toEqual([...rows.map((row) => row.service)].sort((a, b) =>
    ["slack", "github", "linear"].indexOf(a) - ["slack", "github", "linear"].indexOf(b)));
  const map = bySubject(rows);
  expect([...map.keys()].sort()).toEqual([
    "github:acme/api", "github:acme/api#12", "linear:ENG-42", "linear:team/ENG", "slack:T1", "slack:T1/C900", "slack:T1/C902",
  ]);
  expect(map.get("slack:T1/C900")).toMatchObject({ label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 1, activeThreadCount: 1 });
  expect(map.get("slack:T1")).toMatchObject({ label: "Everywhere in Slack", parent: null, listenerCount: 1, activeThreadCount: 0 });
  expect(map.get("slack:T1/C902")).toMatchObject({ parent: "slack:T1", listenerCount: 0, lastActivityAt: 5_000 });
  expect(map.get("github:acme/api")).toMatchObject({ label: "Across acme/api", parent: null, listenerCount: 1 });
  expect(map.get("github:acme/api#12")).toMatchObject({ label: "acme/api#12", parent: "github:acme/api", listenerCount: 0 });
  expect(map.get("linear:team/ENG")).toMatchObject({ label: "Across ENG", listenerCount: 1 });
  expect(map.get("linear:ENG-42")).toMatchObject({ label: "ENG-42", parent: "linear:team/ENG", lastActivityAt: now - DAY });
  // The 31-day-old event and the team's rule add nothing to the personal workspace.
  expect(map.has("linear:ENG-7")).toBe(false);
  expect(map.has("slack:T1/C777")).toBe(false);
  expect(subjectThread.id).toBeTruthy();
});

it("scopes a team workspace to the team's rules and sessions", async () => {
  api = await boot();
  await connectSlack(api);
  const team = await createTeam(api.providers.db, { orgId: ORG, name: "SRE", creatorUserId: USER });
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
  await session.createThread("subject:slack:T1/C778");
  await rule(api, { id: "r-team", ownerType: "team", ownerId: team.id, eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "C777" }] });
  await rule(api, { id: "r-mine", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "C900" }] });
  const personal = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await personal.session.createThread("subject:github:acme/web#1");

  const rows = await places(api, team.id);
  expect(rows.map((row) => row.subject).sort()).toEqual(["slack:T1/C777", "slack:T1/C778"]);
  expect((await fetch(`${api.baseUrl}/api/presence/places?scope=no-such-team`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/presence/places`)).status).toBe(400);
});

it("hides a private channel's place from a viewer outside the channel", async () => {
  api = await boot();
  await connectSlack(api, { CSECRET: ["USOMEONE"] });
  await rule(api, { id: "r-secret", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "CSECRET" }] });
  await rule(api, { id: "r-open", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "COPEN" }] });
  expect((await places(api, "user")).map((row) => row.subject)).toEqual(["slack:T1/COPEN"]);
});

it("shows one place with its listeners, threads of its child places, and recent activity", async () => {
  api = await boot();
  await connectSlack(api);
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(api, { id: "r1", name: "Reviews", eventKeys: ["github.pull_request_review.submitted"], filters: [{ field: "repo", op: "eq", value: "acme/api" }] });
  await rule(api, { id: "r-pr", eventKeys: ["github.pull_request_review.submitted"], filters: [{ field: "subject", op: "eq", value: "github:acme/api#12" }] });
  const pr12 = await session.createThread("subject:github:acme/api#12");
  const pr13 = await session.createThread("subject:github:acme/api#13");
  const other = await session.createThread("subject:github:acme/web#1");
  const waiting = await session.createThread("web:waiting");
  await api.providers.engineStore.createWakeup(waiter({
    id: "w-pr", sessionId, threadId: waiting.id, subjects: ["github:acme/api#13", "github:acme/api"],
    eventMatch: { clauses: [{ key: "github.check_run.completed" }], once: true, self: [], primarySubject: "github:acme/api#13" },
  }));
  const now = Date.now();
  await event(api, { id: "e-pr", service: "github", key: "github.pull_request_review.submitted", subjects: ["github:acme", "github:acme/api", "github:acme/api#12"], at: now - 1000, ruleId: "r1" });

  const subject = encodeURIComponent("github:acme/api");
  const res = await fetch(`${api.baseUrl}/api/presence/places/${subject}?scope=user`);
  expect(res.status).toBe(200);
  const detail = await res.json() as PresencePlaceDetailResponse;
  expect(detail.place).toMatchObject({ subject: "github:acme/api", label: "Across acme/api", listenerCount: 1 });
  expect(detail.listeners.map((l) => l.id)).toEqual(["r1"]);
  expect(detail.threads.subject.map((t) => t.threadId).sort()).toEqual([pr12.id, pr13.id].sort());
  expect(detail.threads.subject.map((t) => t.threadId)).not.toContain(other.id);
  expect(detail.threads.active.map((t) => t.threadId)).toEqual([waiting.id]);
  expect(detail.activity.map((e) => e.id)).toEqual(["e-pr"]);

  const pr = await (await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("github:acme/api#12")}?scope=user`)).json() as PresencePlaceDetailResponse;
  expect(pr.listeners.map((l) => l.id)).toEqual(["r-pr"]);
  expect(pr.threads.subject.map((t) => t.threadId)).toEqual([pr12.id]);

  const missing = await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("github:acme/nothing")}?scope=user`);
  expect(missing.status).toBe(404);
  expect((await missing.json() as { error: string }).error).toMatch(/Open Places/);
});

it("lists what feeds a thread: own, existing, and subject listeners, and own and existing routines", async () => {
  api = await boot();
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  const own = await session.createThread("sub:r-own");
  const pinned = await session.createThread("web:pinned");
  const subjectThread = await session.createThread("subject:github:acme/api#12");
  const routineOwn = await session.createThread("schedule:s-own");
  const plain = await session.createThread("web:plain");

  await rule(api, { id: "r-own", name: "Own listener", eventKeys: ["github.push"], target: { kind: "assistant", thread: { mode: "own" } } });
  await rule(api, { id: "r-pin", name: "Pinned listener", eventKeys: ["github.push"], target: { kind: "assistant", thread: { mode: "existing", sessionId, threadId: pinned.id } } });
  await rule(api, { id: "r-subject", name: "Per pull request", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }], target: { kind: "assistant", thread: { mode: "subject" } } });
  await rule(api, { id: "r-elsewhere", name: "Other repo", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/web" }], target: { kind: "assistant", thread: { mode: "subject" } } });
  await rule(api, { id: "r-new", name: "New each time", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }], target: { kind: "assistant", thread: { mode: "new" } } });

  const schedule = { orgId: ORG, ownerType: "user" as const, ownerId: USER, targetKind: "assistant" as const, prompt: "Summarize", cron: "0 9 * * *", nextFireAt: Date.now() + DAY, createdBy: USER, createdAt: 1, updatedAt: 1 };
  await api.providers.db.insert(workflowSchedules).values([
    { ...schedule, id: "s-own", name: "Morning summary", threadPolicy: null },
    { ...schedule, id: "s-pin", name: "Pinned routine", threadPolicy: { mode: "existing", sessionId, threadId: pinned.id } },
  ]);

  const feeders = async (threadId: string) => {
    const res = await fetch(`${api!.baseUrl}/api/presence/feeders?sessionId=${encodeURIComponent(sessionId)}&threadId=${encodeURIComponent(threadId)}`);
    expect(res.status).toBe(200);
    return await res.json() as ListThreadFeedersResponse;
  };
  expect(await feeders(own.id)).toEqual({ listeners: [{ id: "r-own", name: "Own listener" }], routines: [] });
  expect(await feeders(pinned.id)).toEqual({ listeners: [{ id: "r-pin", name: "Pinned listener" }], routines: [{ id: "s-pin", name: "Pinned routine" }] });
  expect(await feeders(subjectThread.id)).toEqual({ listeners: [{ id: "r-subject", name: "Per pull request" }], routines: [] });
  expect(await feeders(routineOwn.id)).toEqual({ listeners: [], routines: [{ id: "s-own", name: "Morning summary" }] });
  expect(await feeders(plain.id)).toEqual({ listeners: [], routines: [] });
  expect((await fetch(`${api.baseUrl}/api/presence/feeders?sessionId=${sessionId}`)).status).toBe(400);
});

it("refuses the feeders of a thread the viewer cannot read", async () => {
  api = await boot();
  const team = await createTeam(api.providers.db, { orgId: ORG, name: "Secret", creatorUserId: USER });
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
  const hidden = await session.createThread("slack:CPRIVATE:1700.1");
  await connectSlack(api, { CPRIVATE: ["USOMEONE"] });
  const res = await fetch(`${api.baseUrl}/api/presence/feeders?sessionId=${encodeURIComponent(sessionId)}&threadId=${encodeURIComponent(hidden.id)}`);
  expect(res.status).toBe(404);
  expect((await res.json() as { error: string }).error).toBe("This thread belongs to another owner. Open a thread in your workspace.");
  const unknown = await fetch(`${api.baseUrl}/api/presence/feeders?sessionId=no-such-session&threadId=t`);
  expect(unknown.status).toBe(404);
});
