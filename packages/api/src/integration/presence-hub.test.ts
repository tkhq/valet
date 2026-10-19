/**
 * The data half of the Presence hub acceptance scenario
 * (`docs/specs/2026-10-16-presence-hub-design.md`, "Acceptance scenario").
 * The web half, `packages/web/src/routes/-presence-acceptance.test.tsx`,
 * renders H1 to H12 over the real route tree against typed fixtures; this
 * suite proves the api answers those fixtures' shapes over a real database.
 *
 * What runs for real: the api app (`bootTestApi`), the REST routes that
 * create rules, schedules, and threads, event ingest, the event dispatcher,
 * the workflow scheduler, and the presence reads. What is stubbed: Slack's
 * channel lookups (a `fetch` stub for `slack.com`).
 *
 * Universe mapping: org `acme` is the harness org `local-org`, user `u-001`
 * is `local-user`, and team `sre` is a team that `local-user` creates.
 */
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { EventMatchSpec, Wakeup } from "@valet/engine";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { ingestEvent } from "../events/ingest.js";
import { eventDeliveries, followedThreads, workflowSchedules } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import type {
  CreateEventSubscriptionResponse,
  CreateThreadResponse,
  ListEventSubscriptionsResponse,
  ListPresencePlacesResponse,
  ListThreadFeedersResponse,
  ListWorkflowTriggersResponse,
  PresencePlaceDetailResponse,
  WorkflowScheduleResponse,
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const ORG = "local-org";
const USER = "local-user";
const DAY = 24 * 60 * 60 * 1000;
const PIN_UNAVAILABLE = "Pick another thread in Presence.";
const PLUGINS = [slackPlugin, githubPlugin, linearPlugin];

let api: TestApi | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  resetThreadAccessCache();
  await api?.cleanup();
  api = undefined;
});

/** Connects the org Slack bot for team `T1`. Every channel is public. */
async function connectSlack(a: TestApi): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: ORG }, "slack",
    { type: "oauth2", accessToken: "xoxb-test", metadata: { teamId: "T1" } });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "slack.com") return realFetch(input, init);
    const channel = url.searchParams.get("channel") ?? "";
    const body = url.pathname.endsWith("conversations.members")
      ? { ok: true, members: [] }
      : { ok: true, channel: { name: channel === "C900" ? "incidents" : channel.toLowerCase(), is_private: false } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

async function call(a: TestApi, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${a.baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function read<T>(a: TestApi, path: string): Promise<T> {
  const res = await call(a, "GET", path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function createRule(a: TestApi, body: Record<string, unknown>): Promise<string> {
  const res = await call(a, "POST", "/api/event-subscriptions", { ...body, allowCollision: true });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as CreateEventSubscriptionResponse).id;
}

async function createThread(a: TestApi, title: string): Promise<{ sessionId: string; threadId: string }> {
  const res = await call(a, "POST", "/api/threads", { title });
  expect(res.status, await res.clone().text()).toBe(201);
  const thread = (await res.json()) as CreateThreadResponse;
  return { sessionId: thread.sessionId, threadId: thread.id };
}

async function archiveThread(a: TestApi, threadId: string): Promise<void> {
  const res = await call(a, "PATCH", `/api/threads/${threadId}`, { archived: true });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function waiter(over: Partial<Wakeup> & Pick<Wakeup, "id" | "sessionId" | "threadId">): Wakeup {
  const eventMatch: EventMatchSpec = { clauses: [{ key: "slack.message" }], once: false, self: [] };
  return {
    kind: "event", status: "running", reason: "Watching the incident", logOffset: 0, logTail: "", eventCount: 0,
    createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + DAY, subjects: [], eventMatch, eventBuffer: [],
    ...over,
  };
}

const placesOf = (a: TestApi, scope: string) =>
  read<ListPresencePlacesResponse>(a, `/api/presence/places?scope=${encodeURIComponent(scope)}`);
const placeOf = (a: TestApi, scope: string, subject: string) =>
  read<PresencePlaceDetailResponse>(a, `/api/presence/places/${encodeURIComponent(subject)}?scope=${encodeURIComponent(scope)}`);

describe("Presence hub data scenario", () => {
  it("serves places, feeders, a listener's problem, and a routine's disabledReason", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const a = api;
    const p = a.providers;
    await connectSlack(a);
    const team = await createTeam(p.db, { orgId: ORG, name: "SRE", creatorUserId: USER });

    // u-001's rules: R1 per pull request, R4 pinned to `Platform CI`.
    const user = await ensureDefaultAssistantSession(p, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
    const platform = await createThread(a, "Platform CI");
    const repo = [{ field: "repo", op: "eq", value: "acme/api" }];
    const r1 = await createRule(a, {
      name: "Reviews and checks",
      eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
      filters: repo,
      target: { kind: "assistant", thread: { mode: "subject" } },
    });
    const r4 = await createRule(a, {
      name: "Failed checks",
      eventKeys: ["github.check_run.completed"],
      filters: repo,
      target: { kind: "assistant", thread: { mode: "existing", ...platform } },
    });
    const pr12 = await user.session.createThread("subject:github:acme/api#12");
    const pr13 = await user.session.createThread("subject:github:acme/api#13");

    // The sre team's rules: M has its own thread `t-inc`, and P is pinned to it.
    const sre = await ensureDefaultAssistantSession(p, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
    const channel = [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }];
    const m = await createRule(a, {
      name: "M",
      eventKeys: ["slack.app_mention"],
      filters: channel,
      target: { kind: "assistant", assistant: "team", teamId: team.id, appearance: { displayName: "SRE Bot" }, thread: { mode: "own" } },
    });
    const tInc = await sre.session.createThread(`sub:${m}`);
    const pRule = await createRule(a, {
      name: "P",
      eventKeys: ["slack.message"],
      filters: channel,
      target: { kind: "assistant", assistant: "team", teamId: team.id, thread: { mode: "existing", sessionId: sre.sessionId, threadId: tInc.id } },
    });
    await p.engineStore.createWakeup(waiter({ id: "w-inc", sessionId: sre.sessionId, threadId: tInc.id, subjects: ["slack:T1/C900"] }));
    await p.db.insert(followedThreads).values({
      id: "f-inc", orgId: ORG, channelType: "slack", channelId: "C900", threadTs: "1700.1", ownerType: "team", ownerId: team.id,
      createdBy: USER, createdAt: 5, lastActivityAt: 5_000, sessionId: sre.sessionId, threadId: tInc.id,
    });

    // H2: the personal workspace lists acme/api with its two listeners; the
    // team workspace lists #incidents with two listeners and an active thread.
    const userPlaces = new Map((await placesOf(a, "user")).places.map((row) => [row.subject, row]));
    expect(userPlaces.get("github:acme/api")).toMatchObject({
      label: "acme/api", service: "github", scopeLabel: "Across acme/api", listenerCount: 2, activeThreadCount: 0,
    });
    expect(userPlaces.has("slack:T1/C900")).toBe(false);
    const srePlaces = new Map((await placesOf(a, team.id)).places.map((row) => [row.subject, row]));
    expect(srePlaces.get("slack:T1/C900")).toMatchObject({
      label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 2, activeThreadCount: 1,
    });
    expect(srePlaces.has("github:acme/api")).toBe(false);

    // H3: acme/api lists R1 and R4 and the subject threads #12 and #13.
    const acme = await placeOf(a, "user", "github:acme/api");
    expect(acme.listeners.map((l) => l.id).sort()).toEqual([r1, r4].sort());
    expect(acme.listeners.map((l) => l.placeKey)).toEqual(["github:acme/api", "github:acme/api"]);
    expect(acme.threads.subject.map((t) => t.threadId).sort()).toEqual([pr12.id, pr13.id].sort());

    // H4: #incidents in sre lists M (with its appearance) and P, the active
    // thread, and the followed Slack thread.
    const incidents = await placeOf(a, team.id, "slack:T1/C900");
    expect(incidents.listeners.map((l) => l.id).sort()).toEqual([m, pRule].sort());
    expect(incidents.listeners.find((l) => l.id === m)?.target.appearance).toEqual({ displayName: "SRE Bot" });
    expect(incidents.listeners.map((l) => l.placeKey)).toEqual(["slack:T1/C900", "slack:T1/C900"]);
    // W-B2: the list route carries the same row key. A pull request line
    // lists at its repository's row.
    const pr = await createRule(a, {
      name: "One PR",
      eventKeys: ["github.pull_request_review.submitted"],
      filters: [...repo, { field: "pr_number", op: "eq", value: "12" }],
      target: { kind: "assistant", thread: { mode: "subject" } },
    });
    const keyed = await read<ListEventSubscriptionsResponse>(a, `/api/event-subscriptions?ownerType=team&ownerId=${team.id}`);
    expect(keyed.subscriptions.find((s) => s.id === m)?.placeKey).toBe("slack:T1/C900");
    const mine = await read<ListEventSubscriptionsResponse>(a, `/api/event-subscriptions?ownerType=user&ownerId=${USER}`);
    expect(mine.subscriptions.find((s) => s.id === r1)?.placeKey).toBe("github:acme/api");
    expect(mine.subscriptions.find((s) => s.id === pr)?.placeKey).toBe("github:acme/api");
    expect((await call(a, "DELETE", `/api/event-subscriptions/${pr}`)).status).toBe(204);
    expect(incidents.threads.active.map((t) => t.threadId)).toEqual([tInc.id]);
    expect(incidents.threads.following.map((t) => t.threadId)).toEqual([tInc.id]);
    // The team's place is not the personal workspace's.
    expect((await call(a, "GET", `/api/presence/places/${encodeURIComponent("slack:T1/C900")}?scope=user`)).status).toBe(404);

    // H7: `Platform CI` is archived; the next failed check dead-letters R4's
    // delivery, and the list route reports R4's problem.
    await archiveThread(a, platform.threadId);
    await ingestEvent({ db: p.db, plugins: PLUGINS }, {
      orgId: ORG,
      service: "github",
      event: {
        key: "github.check_run.completed",
        dedupeKey: "check-run-h7",
        occurredAt: new Date().toISOString(),
        refs: { repo: "acme/api" },
        summary: "deploy failed on acme/api",
        payload: { action: "completed", repository: { full_name: "acme/api" }, check_run: { name: "deploy", conclusion: "failure" } },
        subjects: ["github:acme", "github:acme/api"],
      },
    });
    const dead = await poll(async () => {
      await p.eventDispatcher.pollOnce();
      return p.db.select().from(eventDeliveries).where(eq(eventDeliveries.subscriptionId, r4));
    }, (rows) => rows.length === 1 && rows[0]?.status === "dead", "R4's dead delivery");
    expect(dead[0]?.lastError).toBe(PIN_UNAVAILABLE);
    const listed = await read<ListEventSubscriptionsResponse>(a, `/api/event-subscriptions?ownerType=user&ownerId=${USER}`);
    expect(listed.subscriptions.find((s) => s.id === r4)?.problem).toBe(PIN_UNAVAILABLE);
    expect(listed.subscriptions.find((s) => s.id === r1)?.problem).toBeUndefined();
    // The place page reads the same problem under R4 (Part C step 5, P3).
    const acmeDead = await placeOf(a, "user", "github:acme/api");
    expect(acmeDead.listeners.find((l) => l.id === r4)?.problem).toBe(PIN_UNAVAILABLE);
    expect(acmeDead.listeners.find((l) => l.id === r1)?.problem).toBeUndefined();
    // A repin clears the problem.
    const ops = await createThread(a, "Platform Ops");
    const repinned = await call(a, "PATCH", `/api/event-subscriptions/${r4}`, { thread: { mode: "existing", ...ops } });
    expect(repinned.status, await repinned.clone().text()).toBe(200);
    const relisted = await read<ListEventSubscriptionsResponse>(a, `/api/event-subscriptions?ownerType=user&ownerId=${USER}`);
    expect(relisted.subscriptions.find((s) => s.id === r4)?.problem).toBeUndefined();

    // H8 and Part D: a routine pinned to an archived thread is turned off at
    // its next fire, and the triggers list reports why.
    const notes = await createThread(a, "Night notes");
    const created = await call(a, "POST", "/api/workflows/schedules", {
      name: "Morning summary", cron: "0 9 * * *", target: { kind: "assistant", prompt: "Summarize the night." },
      thread: { mode: "existing", ...notes },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const s1 = ((await created.json()) as WorkflowScheduleResponse).schedule.scheduleId;
    await archiveThread(a, notes.threadId);
    await p.db.update(workflowSchedules).set({ nextFireAt: Date.now() - 60_000 }).where(eq(workflowSchedules.id, s1));
    await p.workflowScheduler.tick();
    const routines = await poll(
      () => read<ListWorkflowTriggersResponse>(a, `/api/workflows/triggers?ownerType=user&ownerId=${USER}`),
      (res) => res.triggers.some((t) => t.id === s1 && !t.enabled),
      "the routine to turn off",
    );
    const off = routines.triggers.find((t) => t.id === s1);
    expect(off?.kind).toBe("schedule");
    if (off?.kind !== "schedule") throw new Error("S1 is not a schedule");
    expect(off.detail.disabledReason).toBe(PIN_UNAVAILABLE);
    // Picking another thread and turning it on clears the reason.
    const fixed = await call(a, "PATCH", `/api/workflows/schedules/${s1}`, { thread: { mode: "existing", ...ops }, enabled: true });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    const after = (await read<ListWorkflowTriggersResponse>(a, `/api/workflows/triggers?ownerType=user&ownerId=${USER}`))
      .triggers.find((t) => t.id === s1);
    expect(after?.enabled).toBe(true);
    expect(after?.kind === "schedule" ? after.detail.disabledReason : "not a schedule").toBeUndefined();

    // H11: t-inc is fed by M (its own thread) and P (pinned to it).
    const feeders = await read<ListThreadFeedersResponse>(a,
      `/api/presence/feeders?sessionId=${encodeURIComponent(sre.sessionId)}&threadId=${encodeURIComponent(tInc.id)}`);
    expect(feeders).toEqual({ listeners: [{ id: m, name: "M" }, { id: pRule, name: "P" }], routines: [] });
    // Platform Ops now takes R4's deliveries and S1's prompts.
    const opsFeeders = await read<ListThreadFeedersResponse>(a,
      `/api/presence/feeders?sessionId=${encodeURIComponent(ops.sessionId)}&threadId=${encodeURIComponent(ops.threadId)}`);
    expect(opsFeeders).toEqual({ listeners: [{ id: r4, name: "Failed checks" }], routines: [{ id: s1, name: "Morning summary" }] });
  }, 60_000);
});
