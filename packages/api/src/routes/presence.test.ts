import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import slackPlugin from "@valet/plugin-slack/plugin";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import type { EventMatchSpec, Wakeup } from "@valet/engine";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { linkIdentity } from "../channels/identity-links.js";
import { eventDeliveries, eventSubscriptions, events, followedThreads, workflowSchedules } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import { slowPlacesLine } from "./presence.js";
import { resetChannelNameCaches } from "./workspace-channels.js";
import type {
  ListEventSubscriptionsResponse, ListPresencePlacesResponse, ListThreadFeedersResponse, PresencePlaceDetailResponse, PresencePlaceWire,
} from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); resetChannelNameCaches(); await api?.cleanup(); api = undefined; });

const ORG = "local-org";
const USER = "local-user";
const DAY = 24 * 60 * 60 * 1000;

async function boot(): Promise<TestApi> {
  return await bootTestApi({ plugins: [slackPlugin, githubPlugin, linearPlugin] });
}

/** Connects the org Slack bot for team `T1` and answers Slack's channel
 * checks: `members` lists each private channel's members; any other channel
 * is public. `joined` names the channels the bot has joined, by id. The
 * returned list holds each Slack call as `<method> <channel>`. */
async function connectSlack(a: TestApi, members: Record<string, string[]> = {}, joined: Record<string, string> = {}) {
  const calls: string[] = [];
  // The Slack plugin caches its directory and its names by token, so each
  // test's bot has its own token.
  await a.providers.engineCredentials.save({ type: "org", id: ORG }, "slack",
    { type: "oauth2", accessToken: `xoxb-test-${randomUUID()}`, metadata: { teamId: "T1" } });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const privateMembers = members[channel];
    calls.push(`${url.pathname.split("/").pop() ?? ""} ${channel}`.trim());
    const body = url.pathname.endsWith("conversations.members") ? { ok: true, members: privateMembers ?? [] }
      : url.pathname.endsWith("users.conversations")
        ? { ok: true, channels: Object.entries(joined).map(([id, name]) => ({ id, name, is_private: members[id] !== undefined })) }
      : { ok: true, channel: { name: channel.toLowerCase(), is_private: privateMembers !== undefined } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return calls;
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
  expect(map.get("slack:T1/C900")?.scopeLabel).toBeUndefined();
  expect(map.get("slack:T1/C900")).toMatchObject({ label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 1, activeThreadCount: 1 });
  expect(map.get("slack:T1")).toMatchObject({ label: "Everywhere in Slack", scopeLabel: "Everywhere in Slack", parent: null, listenerCount: 1, activeThreadCount: 0 });
  expect(map.get("slack:T1/C902")).toMatchObject({ parent: "slack:T1", listenerCount: 0, lastActivityAt: 5_000 });
  expect(map.get("github:acme/api")).toMatchObject({ label: "acme/api", scopeLabel: "Across acme/api", parent: null, listenerCount: 1 });
  expect(map.get("github:acme/api#12")).toMatchObject({ label: "acme/api#12", parent: "github:acme/api", listenerCount: 0 });
  expect(map.get("linear:team/ENG")).toMatchObject({ label: "ENG", scopeLabel: "Across ENG", listenerCount: 1 });
  expect(map.get("linear:ENG-42")).toMatchObject({ label: "ENG-42", parent: "linear:team/ENG", lastActivityAt: now - DAY });
  // The 31-day-old event and the team's rule add nothing to the personal workspace.
  expect(map.has("linear:ENG-7")).toBe(false);
  expect(map.has("slack:T1/C777")).toBe(false);
  expect(subjectThread.id).toBeTruthy();
});

it("lists the parent of a lone child place, with no counts and the child's activity", async () => {
  api = await boot();
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  const lone = await session.createThread("subject:github:acme/api#12");
  const rows = await places(api, "user");
  expect(rows).toHaveLength(2);
  const map = bySubject(rows);
  expect(map.get("github:acme/api#12")).toMatchObject({ parent: "github:acme/api", label: "acme/api#12" });
  const child = map.get("github:acme/api#12")!;
  expect(map.get("github:acme/api")).toEqual({
    subject: "github:acme/api", label: "acme/api", service: "github", parent: null,
    listenerCount: 0, activeThreadCount: 0, lastActivityAt: child.lastActivityAt,
  });
  expect(child.lastActivityAt).not.toBeNull();
  expect(lone.id).toBeTruthy();
  // The synthesized parent opens as a place page with its child's thread.
  const detail = await (await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("github:acme/api")}?scope=user`)).json() as PresencePlaceDetailResponse;
  expect(detail.threads.subject.map((t) => t.threadId)).toEqual([lone.id]);
});

// Final review G4: a row whose only line rolls up to it still names its reach.
it("names the reach of a repository row whose only line is a pull request line", async () => {
  api = await boot();
  await rule(api, { id: "r-pr", eventKeys: ["github.pull_request_review.submitted"], filters: [{ field: "subject", op: "eq", value: "github:acme/api#12" }] });
  const map = bySubject(await places(api, "user"));
  expect(map.get("github:acme/api")).toMatchObject({ scopeLabel: "Across acme/api", listenerCount: 1 });
  expect(map.get("github:acme/api#12")?.scopeLabel).toBeUndefined();
});

// Final review G3: the list route and the place page pick the Slack
// workspace the same way, so a line's `placeKey` agrees on both.
it("gives a Slack line the same placeKey on the list and the place page with no credential", async () => {
  api = await boot();
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await session.createThread("subject:slack:T7/C5/1700.1");
  await rule(api, { id: "r-slack", eventKeys: ["slack.message"] });
  const list = await fetch(`${api.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=${USER}`);
  expect(list.status).toBe(200);
  const listed = (await list.json() as ListEventSubscriptionsResponse).subscriptions.find((row) => row.id === "r-slack");
  expect(listed?.placeKey).toBe("slack:T7");
  const page = await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("slack:T7")}?scope=user`);
  expect(page.status).toBe(200);
  const detail = await page.json() as PresencePlaceDetailResponse;
  expect(detail.listeners.map((row) => row.placeKey)).toEqual([listed?.placeKey]);
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
  expect(rows.map((row) => row.subject).sort()).toEqual(["slack:T1", "slack:T1/C777", "slack:T1/C778"]);
  expect((await fetch(`${api.baseUrl}/api/presence/places?scope=no-such-team`)).status).toBe(404);
  // A team that exists, but that the viewer is not on, reads as missing.
  const theirs = await createTeam(api.providers.db, { orgId: ORG, name: "Elsewhere", creatorUserId: "other-user" });
  const refused = await fetch(`${api.baseUrl}/api/presence/places?scope=${encodeURIComponent(theirs.id)}`);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toEqual({ error: "Workspace not found. Select an accessible workspace." });
  expect((await fetch(`${api.baseUrl}/api/presence/places`)).status).toBe(400);
});

it("hides a private channel's place from a viewer outside the channel", async () => {
  api = await boot();
  await connectSlack(api, { CSECRET: ["USOMEONE"] });
  await rule(api, { id: "r-secret", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "CSECRET" }] });
  await rule(api, { id: "r-open", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "COPEN" }] });
  expect((await places(api, "user")).map((row) => row.subject).sort()).toEqual(["slack:T1", "slack:T1/COPEN"]);
});

it("resolves a channel-only Slack key to the org's Slack workspace", async () => {
  api = await boot();
  // With no Slack workspace connected, a channel-only key names no place.
  const unplaced = await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("slack:C900")}?scope=user`);
  expect(unplaced.status).toBe(404);
  expect(await unplaced.json()).toEqual({ error: "That Slack channel has no workspace in its link. Pick the channel from Presence." });

  await connectSlack(api);
  await rule(api, { id: "r-inc", eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: "C900" }] });
  const res = await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("slack:C900")}?scope=user`);
  expect(res.status).toBe(200);
  const detail = await res.json() as PresencePlaceDetailResponse;
  expect(detail.place).toMatchObject({ subject: "slack:T1/C900", service: "slack" });
  expect(detail.listeners.map((l) => l.id)).toEqual(["r-inc"]);
  // The workspace key itself still opens the workspace row.
  const top = await (await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("slack:T1")}?scope=user`)).json() as PresencePlaceDetailResponse;
  expect(top.place.subject).toBe("slack:T1");
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
  // The pull request line rolls up to this row (its `placeKey`), so the
  // repository's page lists it beside the repository's own line.
  expect(detail.place).toMatchObject({ subject: "github:acme/api", label: "acme/api", scopeLabel: "Across acme/api", listenerCount: 2 });
  expect(detail.listeners.map((l) => l.id).sort()).toEqual(["r-pr", "r1"]);
  expect(detail.listeners.map((l) => l.placeKey)).toEqual(["github:acme/api", "github:acme/api"]);
  expect(detail.threads.subject.map((t) => t.threadId).sort()).toEqual([pr12.id, pr13.id].sort());
  expect(detail.threads.subject.map((t) => t.threadId)).not.toContain(other.id);
  expect(detail.threads.active.map((t) => t.threadId)).toEqual([waiting.id]);
  expect(detail.activity.map((e) => e.id)).toEqual(["e-pr"]);

  const pr = await (await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("github:acme/api#12")}?scope=user`)).json() as PresencePlaceDetailResponse;
  expect(pr.listeners.map((l) => l.id)).toEqual(["r-pr"]);
  expect(pr.threads.subject.map((t) => t.threadId)).toEqual([pr12.id]);

  const missing = await fetch(`${api.baseUrl}/api/presence/places/${encodeURIComponent("github:acme/nothing")}?scope=user`);
  expect(missing.status).toBe(404);
  expect((await missing.json() as { error: string }).error).toMatch(/Open Presence/);
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
  await rule(api, { id: "r-off", name: "Off listener", eventKeys: ["github.push"], target: { kind: "assistant", thread: { mode: "existing", sessionId, threadId: pinned.id } } });
  await api.providers.db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "r-off"));
  // An org rule delivers into the org's assistant, never into this workspace's subject thread.
  await rule(api, { id: "r-org", ownerType: "org", ownerId: ORG, name: "Org per pull request", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }], target: { kind: "assistant", thread: { mode: "subject" } } });
  await rule(api, { id: "r-new", name: "New each time", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }], target: { kind: "assistant", thread: { mode: "new" } } });

  const schedule = { orgId: ORG, ownerType: "user" as const, ownerId: USER, targetKind: "assistant" as const, prompt: "Summarize", cron: "0 9 * * *", nextFireAt: Date.now() + DAY, createdBy: USER, createdAt: 1, updatedAt: 1 };
  await api.providers.db.insert(workflowSchedules).values([
    { ...schedule, id: "s-own", name: "Morning summary", threadPolicy: null },
    { ...schedule, id: "s-pin", name: "Pinned routine", threadPolicy: { mode: "existing", sessionId, threadId: pinned.id } },
    { ...schedule, id: "s-off", name: "Off routine", enabled: false, threadPolicy: { mode: "existing", sessionId, threadId: pinned.id } },
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

/** A personal workspace with a broad Slack listener, a private channel
 * `CSECRET` that the viewer is not in, and a public channel `COPEN`. The
 * private channel has an event, a subject thread, a follow binding, and a
 * running waiter; `CPRIV2` is private and known only from an event. */
async function seedPrivateChannel(a: TestApi) {
  await connectSlack(a, { CSECRET: ["USOMEONE"], CPRIV2: ["USOMEONE"] });
  const { session, sessionId } = await ensureDefaultAssistantSession(a.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(a, { id: "r-all", name: "Everywhere", eventKeys: ["slack.app_mention"] });
  const subjectThread = await session.createThread("subject:slack:T1/CSECRET");
  const followThread = await session.createThread("web:follow");
  const waiting = await session.createThread("web:waiting");
  await a.providers.db.insert(followedThreads).values({
    id: "f-secret", orgId: ORG, channelType: "slack", channelId: "CSECRET", threadTs: "1700.9", ownerType: "user", ownerId: USER,
    createdBy: USER, createdAt: 5, lastActivityAt: 5_000, sessionId, threadId: followThread.id,
  });
  await a.providers.engineStore.createWakeup(waiter({ id: "w-secret", sessionId, threadId: waiting.id, subjects: ["slack:T1/CSECRET"] }));
  const now = Date.now();
  const slackEvent = (id: string, channel: string) => event(a, {
    id, service: "slack", key: "slack.app_mention", subjects: ["slack:T1", `slack:T1/${channel}`], at: now - 1000, ruleId: "r-all", refs: { channel },
  });
  await slackEvent("e-secret", "CSECRET");
  await slackEvent("e-priv2", "CPRIV2");
  await slackEvent("e-open", "COPEN");
  return { subjectThread, followThread, waiting };
}

const detailOf = (a: TestApi, subject: string) => fetch(`${a.baseUrl}/api/presence/places/${encodeURIComponent(subject)}?scope=user`);

it("answers a private channel's place page with the same 404 as an absent place", async () => {
  api = await boot();
  await seedPrivateChannel(api);
  const hidden = await detailOf(api, "slack:T1/CSECRET");
  const absent = await detailOf(api, "slack:T1/CNOWHERE");
  expect(hidden.status).toBe(404);
  expect(absent.status).toBe(404);
  const absentBody: unknown = await absent.json();
  expect(await hidden.json()).toEqual(absentBody);
  // A channel-only key resolves to the same hidden channel and answers the same 404.
  const channelOnly = await detailOf(api, "slack:CSECRET");
  expect(channelOnly.status).toBe(404);
  expect(await channelOnly.json()).toEqual(absentBody);
  // A member sees the same page.
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "USOMEONE", userId: USER });
  expect((await detailOf(api, "slack:T1/CSECRET")).status).toBe(200);
});

it("leaves a private channel's event, subject thread, follow, and waiter out of the Slack parent page", async () => {
  api = await boot();
  const seeded = await seedPrivateChannel(api);
  const res = await detailOf(api, "slack:T1");
  expect(res.status).toBe(200);
  const detail = await res.json() as PresencePlaceDetailResponse;
  expect(detail.listeners.map((l) => l.id)).toEqual(["r-all"]);
  expect(detail.activity.map((e) => e.id)).toEqual(["e-open"]);
  expect(detail.threads.subject.map((t) => t.threadId)).not.toContain(seeded.subjectThread.id);
  expect(detail.threads.following.map((t) => t.threadId)).not.toContain(seeded.followThread.id);
  expect(detail.threads.active.map((t) => t.threadId)).not.toContain(seeded.waiting.id);
  expect(detail.threads).toEqual({ subject: [], following: [], active: [] });
});

it("hides a private place that only an event names", async () => {
  api = await boot();
  await seedPrivateChannel(api);
  const subjects = (await places(api, "user")).map((row) => row.subject);
  expect(subjects).toContain("slack:T1/COPEN");
  expect(subjects).not.toContain("slack:T1/CPRIV2");
  expect(subjects).not.toContain("slack:T1/CSECRET");
});

it("lists a follow's channel only when its bound thread is visible, and keeps a legacy follow", async () => {
  api = await boot();
  await connectSlack(api, { CPRIVX: ["USOMEONE"] });
  const team = await createTeam(api.providers.db, { orgId: ORG, name: "SRE", creatorUserId: USER });
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
  const hidden = await session.createThread("slack:CPRIVX:1700.1");
  const follow = { orgId: ORG, channelType: "slack", ownerType: "team" as const, ownerId: team.id, createdBy: USER, createdAt: 5, lastActivityAt: 5_000 };
  await api.providers.db.insert(followedThreads).values([
    // Bound to a thread this viewer may not see.
    { ...follow, id: "f-hidden", channelId: "CPUB", threadTs: "1700.1", sessionId, threadId: hidden.id },
    // Bound to a thread outside this workspace's sessions.
    { ...follow, id: "f-elsewhere", channelId: "CPUB2", threadTs: "1700.2", sessionId: "another-session", threadId: "t-other" },
    // Bound before the thread columns.
    { ...follow, id: "f-legacy", channelId: "COLD", threadTs: "1700.3", sessionId: null, threadId: null },
  ]);
  const map = bySubject(await places(api, team.id));
  expect(map.has("slack:T1/CPUB")).toBe(false);
  expect(map.has("slack:T1/CPUB2")).toBe(false);
  expect(map.get("slack:T1/COLD")).toMatchObject({ lastActivityAt: 5_000, listenerCount: 0 });
  // The synthesized Slack parent has no listeners, so it carries no reach.
  expect(map.get("slack:T1")).toMatchObject({ label: "Everywhere in Slack", listenerCount: 0 });
  expect(map.get("slack:T1")?.scopeLabel).toBeUndefined();
});

it("logs a places read only when it takes longer than a second", () => {
  expect(slowPlacesLine("team_1", 1500.4, 6)).toBe("presence places: team_1 took 1500 ms over 6 sessions");
  expect(slowPlacesLine("user", 1000, 1)).toBeNull();
});

it("sends only the places on the list route", async () => {
  api = await boot();
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await session.createThread("subject:github:acme/api#12");
  const res = await fetch(`${api.baseUrl}/api/presence/places?scope=user`);
  expect(Object.keys(await res.json() as Record<string, unknown>)).toEqual(["places", "channelNames"]);
});

/** The places read as the overview reads it. */
async function placesRead(a: TestApi, scope: string): Promise<ListPresencePlacesResponse> {
  const res = await fetch(`${a.baseUrl}/api/presence/places?scope=${encodeURIComponent(scope)}`);
  expect(res.status).toBe(200);
  return await res.json() as ListPresencePlacesResponse;
}

// Dev, 10-21: a line over 21 channels lists at the Slack workspace, so its 8
// channels with no event in 30 days were no place and read as raw ids.
it("names every public channel a line lists, though no event made it a place", async () => {
  api = await boot();
  const calls = await connectSlack(api, { CPRIV: ["USOMEONE"] }, { C900: "incidents", C950: "alerts-prod", CPRIV: "secret-plans" });
  await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(api, { id: "r-alerts", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: ["C900", "C950", "CPRIV", "CGONE"] }] });

  const read = await placesRead(api, "user");
  expect(read.places.map((row) => row.subject)).toEqual(["slack:T1"]);
  // A private channel that is no place keeps its id, and the bot has not
  // joined CGONE. The read takes one list of the bot's channels and checks
  // no channel one by one.
  expect(read.channelNames).toEqual({ C900: "incidents", C950: "alerts-prod" });
  expect(calls).toEqual(["users.conversations"]);

  // A second read asks Slack nothing.
  expect((await placesRead(api, "user")).channelNames).toEqual({ C900: "incidents", C950: "alerts-prod" });
  expect(calls).toEqual(["users.conversations"]);
});

// Review of PR #1012: a channel that went private after the bot's list was
// read must not show its name when the check hides its place.
it("names no channel whose place the check hid, though the list still calls it public", async () => {
  api = await boot();
  await api.providers.engineCredentials.save({ type: "org", id: ORG }, "slack",
    { type: "oauth2", accessToken: `xoxb-test-${randomUUID()}`, metadata: { teamId: "T1" } });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const body = url.pathname.endsWith("users.conversations")
      ? { ok: true, channels: [{ id: "C900", name: "formerly-public", is_private: false }, { id: "C950", name: "alerts-prod", is_private: false }] }
      : url.pathname.endsWith("conversations.members") ? { ok: true, members: [] }
      : { ok: true, channel: { name: channel.toLowerCase(), is_private: channel === "C900" } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(api, { id: "r-secret", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "eq", value: "C900" }] });
  await rule(api, { id: "r-alerts", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: ["C900", "C950"] }] });

  const read = await placesRead(api, "user");
  expect(read.places.map((row) => row.subject)).not.toContain("slack:T1/C900");
  expect(read.channelNames).toEqual({ C950: "alerts-prod" });
});

// Review of PR #1012: one conversations.info call for each channel did not
// fit Slack's rate limit, and the channel picker stops at 100 channels.
it("names a line's channels past the picker's first 100 with no Slack call for each channel", async () => {
  api = await boot();
  const ids = Array.from({ length: 150 }, (_, n) => `C${String(n).padStart(3, "0")}`);
  const calls = await connectSlack(api, {}, Object.fromEntries(ids.map((id) => [id, `ch-${id.slice(1)}`])));
  await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  const listed = ids.slice(100, 125);
  await rule(api, { id: "r-many", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: listed }] });

  const read = await placesRead(api, "user");
  expect(read.channelNames).toEqual(Object.fromEntries(listed.map((id) => [id, `ch-${id.slice(1)}`])));
  expect(calls).toEqual(["users.conversations"]);
});

it("reads a renamed channel's new name once the five-minute list expires", async () => {
  api = await boot();
  const joined = { C950: "alerts-prod" };
  await connectSlack(api, {}, joined);
  await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(api, { id: "r-alerts", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: ["C950", "C951"] }] });
  expect((await placesRead(api, "user")).channelNames).toEqual({ C950: "alerts-prod" });

  joined.C950 = "alerts-production";
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
  expect((await placesRead(api, "user")).channelNames).toEqual({ C950: "alerts-production" });
});

// Review of PR #1012: the place page sends no channel names, so a line's
// channels must not cost it a Slack call.
it("asks Slack nothing for a line's channels on a place page", async () => {
  api = await boot();
  const calls = await connectSlack(api, {}, { C950: "alerts-prod" });
  const { session } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await session.createThread("subject:github:acme/api#12");
  await rule(api, { id: "r-alerts", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: ["C950", "C951"] }] });
  expect((await detailOf(api, "github:acme/api#12")).status).toBe(200);
  expect(calls).toEqual([]);
});

// Review of PR #1012: a rate-limited scan must not make every read wait again.
it("keeps a failed channel list for a minute instead of asking Slack on every read", async () => {
  api = await boot();
  await api.providers.engineCredentials.save({ type: "org", id: ORG }, "slack",
    { type: "oauth2", accessToken: `xoxb-test-${randomUUID()}`, metadata: { teamId: "T1" } });
  const realFetch = globalThis.fetch;
  let scans = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    scans += 1;
    return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": "0" } });
  });
  await ensureDefaultAssistantSession(api.providers, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
  await rule(api, { id: "r-alerts", eventKeys: ["slack.message"], filters: [{ field: "channel", op: "in", value: ["C950", "C951"] }] });

  expect((await placesRead(api, "user")).channelNames).toEqual({});
  const first = scans;
  expect(first).toBeGreaterThan(0);
  expect((await placesRead(api, "user")).channelNames).toEqual({});
  expect(scans).toBe(first);
});
