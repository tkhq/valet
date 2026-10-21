/**
 * The places read costs a fixed number of database round trips, whatever the
 * number of conversations a team workspace has, and it never reads an event
 * payload (spec 2026-10-16: presence hub, Part B step 10).
 */
import { afterEach, expect, it, vi } from "vitest";
import { sql, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import githubPlugin from "@valet/plugin-github/plugin";
import type { EventMatchSpec, Wakeup } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, eventSubscriptions, events, followedThreads, slackChannelPrivacy } from "../schema/index.js";
import { createTeam } from "./teams.js";
import { listPresencePlaces, type PresenceAccess } from "./presence-places.js";
import { resetThreadAccessCache, visibleThreadIds } from "./thread-access.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

const ORG = "local-org";
const USER = "local-user";
const DAY = 24 * 60 * 60 * 1000;
/** When the seeded event arrived: inside the 30-day window. */
const EVENT_AT = Date.now() - DAY;

/**
 * The database round trips one team places read issues: the workspace's
 * root session, its execution sessions, its follow bindings, its place
 * threads, one visibility pass over them, its recent events, two reads to
 * find the Slack workspace when no credential names it, and its listeners.
 * The running waiters are one more read, through the engine store. A Slack
 * channel that a shown thread holds adds one privacy read the first time
 * this process sees it, so that count grows with distinct channels, never
 * with sessions or threads.
 */
const PLACES_QUERY_BOUND = 9;

interface QueryLog {
  queries: number;
  /** The SQL text of every raw statement. */
  statements: string[];
  /** The selected fields of every `select` from `events`; undefined selects every column. */
  eventSelects: Array<unknown>;
}

/** Wraps a builder so its `from(events)` records the fields the select names. */
function watchFrom(builder: unknown, fields: unknown, log: QueryLog): unknown {
  if (typeof builder !== "object" || builder === null) return builder;
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "from" && typeof value === "function") {
        return (table: unknown, ...rest: unknown[]) => {
          if (table === events) log.eventSelects.push(fields);
          return value.call(target, table, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `db` with every `execute` and `select` counted as one round trip. */
function countingDb(db: AppDb): { db: AppDb; log: QueryLog } {
  const log: QueryLog = { queries: 0, statements: [], eventSelects: [] };
  const dialect = new PgDialect();
  const counted = new Proxy(db, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "execute" && typeof value === "function") {
        return (query: unknown) => {
          log.queries++;
          log.statements.push(query instanceof SQL ? dialect.sqlToQuery(query).sql : String(query));
          return value.call(target, query);
        };
      }
      if (prop === "select" && typeof value === "function") {
        return (...args: unknown[]) => {
          log.queries++;
          return watchFrom(value.apply(target, args), args[0], log);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, log };
}

function waiter(over: Partial<Wakeup> & Pick<Wakeup, "id" | "sessionId" | "threadId">): Wakeup {
  const eventMatch: EventMatchSpec = { clauses: [{ key: "github.pull_request.*" }], once: false, self: [] };
  return {
    kind: "event", status: "running", reason: "Watching", logOffset: 0, logTail: "", eventCount: 0,
    createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + DAY, subjects: [], eventMatch, eventBuffer: [],
    ...over,
  };
}

/** Reads the team's places through a counted database, as the route reads them. */
async function countedPlaces(a: TestApi, teamId: string) {
  const { db, log } = countingDb(a.providers.db);
  const shownCalls: Array<Array<{ sessionId: string; threadId: string }>> = [];
  const access: PresenceAccess = {
    directory: async () => new Map(),
    canSee: async () => true,
    threadsShown: async (threads) => {
      shownCalls.push([...threads]);
      return visibleThreadIds({ db, engineCredentials: a.providers.engineCredentials }, { ownerType: "team" }, { orgId: ORG, userId: USER }, threads);
    },
    slackTeamId: async () => null,
  };
  const perSession = vi.spyOn(a.providers.engineStore, "listWakeups");
  const batched = vi.spyOn(a.providers.engineStore, "listWakeupsForSessions");
  const result = await listPresencePlaces({ db, engineStore: a.providers.engineStore, plugins: a.providers.plugins },
    ORG, { type: "team", id: teamId }, access);
  const wakeupReads = perSession.mock.calls.length + batched.mock.calls.length;
  perSession.mockRestore();
  batched.mockRestore();
  return { places: result.places, log, shownCalls, wakeupReads };
}

async function teamListener(a: TestApi, teamId: string) {
  await a.providers.db.insert(eventSubscriptions).values({
    id: `r-${teamId}`, orgId: ORG, ownerType: "team", ownerId: teamId, name: "Pull requests",
    eventKeys: ["github.pull_request.*"], filters: [{ field: "repo", op: "eq", value: "acme/api" }], target: { kind: "assistant" },
    enabled: true, createdBy: USER, createdAt: 1, updatedAt: 1,
  });
  // An event with a large payload: the read places it from its subjects.
  const at = EVENT_AT;
  await a.providers.db.insert(events).values({
    id: `e-${teamId}`, orgId: ORG, service: "github", eventKey: "github.pull_request.opened", dedupeKey: `e-${teamId}`, refs: {},
    summary: "Pull request opened", payload: { body: "x".repeat(30_000) }, occurredAt: at, receivedAt: at,
    subjects: ["github:acme/api", "github:acme/api#900"],
  });
  await a.providers.db.insert(eventDeliveries).values({
    id: `d-${teamId}`, eventId: `e-${teamId}`, subscriptionId: `r-${teamId}`, status: "delivered", nextAttemptAt: at, createdAt: at,
  });
}

function expectNoPayloadRead(log: QueryLog) {
  expect(log.eventSelects.length).toBeGreaterThan(0);
  for (const fields of log.eventSelects) {
    // A select with no fields reads every column, the payload too.
    expect(fields).toBeDefined();
    expect(Object.values(fields ?? {})).not.toContain(events.payload);
  }
  for (const statement of log.statements) expect(statement).not.toMatch(/payload/i);
}

/** A team with `executions` execution sessions, each with a subject thread and a thread that waits on the same pull request. */
async function seedTeam(a: TestApi, executions: number): Promise<string> {
  const team = await createTeam(a.providers.db, { orgId: ORG, name: `Team ${executions}`, creatorUserId: USER });
  const owner = { type: "team" as const, id: team.id };
  const meta = { actorUserId: USER, orgId: ORG };
  const root = await ensureDefaultAssistantSession(a.providers, owner, meta);
  const sessions = executions === 0 ? [root]
    : await Promise.all(Array.from({ length: executions }, (_, n) => ensureAssistantExecution(a.providers, owner, meta, `sub:rule-${n}`)));
  for (const [n, { session, sessionId }] of sessions.entries()) {
    await session.createThread(`subject:github:acme/api#${n + 1}`);
    const watching = await session.createThread(`web:watching-${n}`);
    await a.providers.engineStore.createWakeup(waiter({ id: `w-${team.id}-${n}`, sessionId, threadId: watching.id, subjects: [`github:acme/api#${n + 1}`] }));
  }
  await teamListener(a, team.id);
  return team.id;
}

it("reads a team's places in a fixed number of queries for 25 conversations and for one", async () => {
  api = await bootTestApi({ plugins: [githubPlugin] });
  const many = await countedPlaces(api, await seedTeam(api, 25));
  const one = await countedPlaces(api, await seedTeam(api, 0));

  for (const read of [many, one]) {
    expect(read.log.queries).toBeLessThanOrEqual(PLACES_QUERY_BOUND);
    expect(read.wakeupReads).toBe(1);
    expect(read.shownCalls).toHaveLength(1);
    expectNoPayloadRead(read.log);
  }
  expect(many.log.queries).toBe(one.log.queries);

  // Every conversation still shows: its subject thread's place, with its waiter active.
  const rows = new Map(many.places.map((row) => [row.subject, row]));
  for (let n = 1; n <= 25; n++) expect(rows.get(`github:acme/api#${n}`)).toMatchObject({ parent: "github:acme/api", activeThreadCount: 1 });
  expect(new Map(one.places.map((row) => [row.subject, row])).get("github:acme/api#1")).toMatchObject({ activeThreadCount: 1 });
  // The event lists at its place from its subjects, with no payload read.
  expect(rows.get("github:acme/api#900")).toMatchObject({ parent: "github:acme/api", lastActivityAt: EVENT_AT });
  expect(rows.get("github:acme/api")).toMatchObject({ listenerCount: 1 });
});

it("judges only the threads a place can show, not every thread of the workspace", async () => {
  api = await bootTestApi({ plugins: [githubPlugin] });
  const team = await createTeam(api.providers.db, { orgId: ORG, name: "Busy", creatorUserId: USER });
  const { session, sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "team", id: team.id }, { actorUserId: USER, orgId: ORG });
  // 300 threads that no place shows: web, rule, and Slack conversations.
  const unrelated = Array.from({ length: 300 }, (_, n) => [`web:chat-${n}`, `sub:rule-${n}`, `slack:C${n}:1700.${n}`][n % 3]!);
  await api.providers.db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at) VALUES
    ${sql.join(unrelated.map((key, n) => sql`(${`noise-${n}`}, ${sessionId}, ${key}, 'idle', 'steer', 1, 1)`), sql`, `)}`);
  const subject = await session.createThread("subject:github:acme/api#1");
  const watching = await session.createThread("web:watching");
  const followed = await session.createThread("slack:C900:1700.5");
  await api.providers.engineStore.createWakeup(waiter({ id: "w-1", sessionId, threadId: watching.id, subjects: ["github:acme/api#2"] }));
  await api.providers.db.insert(followedThreads).values({
    id: "f-1", orgId: ORG, channelType: "slack", channelId: "C900", threadTs: "1700.5", ownerType: "team", ownerId: team.id,
    createdBy: USER, createdAt: 5, lastActivityAt: 5_000, sessionId, threadId: followed.id,
  });
  // The followed thread's Slack channel is public.
  await api.providers.db.insert(slackChannelPrivacy).values({ orgId: ORG, channelId: "C900", isPrivate: false, checkedAt: Date.now() });
  await teamListener(api, team.id);

  const read = await countedPlaces(api, team.id);
  // One more read classifies the one Slack channel the shown threads hold.
  expect(read.log.queries).toBeLessThanOrEqual(PLACES_QUERY_BOUND + 1);
  expect(read.shownCalls).toHaveLength(1);
  expect(read.shownCalls[0]!.map((ref) => ref.threadId).sort()).toEqual([subject.id, watching.id, followed.id].sort());
  expectNoPayloadRead(read.log);
  const rows = new Map(read.places.map((row) => [row.subject, row]));
  expect(rows.get("github:acme/api#1")).toBeDefined();
  expect(rows.get("github:acme/api#2")).toMatchObject({ activeThreadCount: 1 });
  expect(rows.get("slack:?/C900")).toMatchObject({ lastActivityAt: 5_000 });
});
