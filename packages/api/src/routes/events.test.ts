import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * `/api/events*` + `/api/event-subscriptions` route tests (event-system plan,
 * Task 7). Real Hono app via `bootTestApi` with the real github plugin's
 * trigger catalog; rows seeded straight through `providers.db`; cross-org
 * cases seed rows under a second org id (stub auth pins the caller to
 * `local-org`, so "another org" is expressed in data, not identity).
 */
import type { ValetPlugin } from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { RunHost } from "@valet/workflow";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventDeliveryDispatchId, eventDeliveryRunId } from "../events/dispatcher.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  eventDeliveries,
  eventReceipts,
  events,
  eventSubscriptions,
  orgMembers,
  sessionThreads,
  slackChannelPrivacy,
  teamMembers,
  teams,
  userIdentityLinks,
  workflowDefinitions,
} from "../schema/index.js";
import * as teamsService from "../services/teams.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { seedAssistantThread } from "../test-helpers/assistant-thread.js";
import { deleteTeam } from "../services/teams.js";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  EventSubscriptionCollisionErrorWire,
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  ListSubscriptionDeliveriesResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  EventLogResponse,
  LineActivityResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "../wire/types.js";
import * as workflowService from "../workflows/service.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: [githubPlugin] });
  return api;
}

/** The message both owner-filtered listings answer with when one half of
 * the pair is missing. The same string the workflows and skills suites
 * assert, because one client builds one query for all of them. */
const HALF_FILTER_ERROR = "Filter by owner with both ownerType and ownerId, or send neither.";

const VALID_BODY: CreateEventSubscriptionRequest = {
  name: "pr opens",
  eventKeys: ["github.pull_request.opened"],
  filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
  target: { kind: "assistant" },
};

async function postSubscription(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/event-subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function patchSubscription(
  baseUrl: string,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/event-subscriptions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface SeedSubscriptionOpts {
  name?: string;
  eventKeys?: string[];
  filters?: EventSubscriptionFilterWire[];
  target?: EventSubscriptionTargetWire;
  enabled?: boolean;
  /** Defaults to the colleague pair `user`/`someone` — neither the stub
   * caller (`local-user`) nor the alternate identity (`test-member`). */
  ownerType?: "user" | "team" | "org";
  ownerId?: string;
}

/** Seeds a subscription row directly (bypassing route validation) — used for
 * cross-org 404 cases where the route would refuse to create the row, and for
 * redelivery cases that need a disabled row or a workflow target without a
 * CRUD round trip. */
async function seedSubscriptionRow(
  a: TestApi,
  id: string,
  orgId: string,
  opts: SeedSubscriptionOpts = {},
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id,
    orgId,
    ownerType: opts.ownerType ?? "user",
    ownerId: opts.ownerId ?? "someone",
    name: opts.name ?? `seeded ${id}`,
    eventKeys: opts.eventKeys ?? ["github.push"],
    filters: opts.filters ?? [],
    target: opts.target ?? { kind: "assistant" },
    enabled: opts.enabled ?? true,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEventRow(
  a: TestApi,
  args: { id: string; orgId?: string; service?: string; eventKey?: string; receivedAt: number; subjects?: string[] },
): Promise<void> {
  await a.providers.db.insert(events).values({
    id: args.id,
    orgId: args.orgId ?? "local-org",
    service: args.service ?? "github",
    eventKey: args.eventKey ?? "github.pull_request.opened",
    dedupeKey: `dedupe-${args.id}`,
    actor: { externalId: "42", login: "octocat" },
    refs: { repo: "acme/widgets" },
    summary: `event ${args.id}`,
    payload: { repository: { full_name: "acme/widgets" } },
    occurredAt: args.receivedAt,
    receivedAt: args.receivedAt,
    subjects: args.subjects ?? null,
  });
}

describe("GET /api/events/catalog", () => {
  it("returns the merged plugin catalog grouped by service", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/events/catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetEventCatalogResponse;

    const github = body.services.find((s) => s.service === "github");
    expect(github).toBeDefined();
    const prOpened = github!.entries.find((e) => e.key === "github.pull_request.opened");
    expect(prOpened).toBeDefined();
    expect(prOpened!.filters.map((f) => f.field)).toContain("repo");
    // Non-actioned family appears as a bare key.
    expect(github!.entries.some((e) => e.key === "github.push")).toBe(true);
    // The subscription editor never offers a derived key (event wakeups spec, Part G).
    expect(github!.entries.some((e) => e.key === "github.pull_request.checks_completed")).toBe(false);
  });
});

describe("POST /api/event-subscriptions", () => {
  it("persists, replaces, and clears the appearance without changing the match", async () => {
    const a = await boot();
    const appearance = { displayName: "Issue helper", avatarUrl: "https://example.com/a.webp" };
    const created = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { ...VALID_BODY.target, appearance } });
    expect(created.status).toBe(201);
    const body = await created.json() as CreateEventSubscriptionResponse;
    expect(body.target).toMatchObject({ appearance });
    const invalid = await patchSubscription(a.baseUrl, body.id, { appearance: { avatarUrl: "http://example.com/a" } });
    expect(invalid.status).toBe(400);
    const replaced = await patchSubscription(a.baseUrl, body.id, { appearance: { displayName: "New helper" } });
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as CreateEventSubscriptionResponse).target).toMatchObject({ appearance: { displayName: "New helper" } });
    const cleared = await patchSubscription(a.baseUrl, body.id, { appearance: null });
    expect(cleared.status).toBe(200);
    const result = await cleared.json() as CreateEventSubscriptionResponse;
    expect(result.target).not.toHaveProperty("appearance");
    expect(result.filters).toEqual(VALID_BODY.filters);
  });

  it("201s a valid orchestrator subscription and writes a user-owned row", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("pr opens");
    expect(body.enabled).toBe(true);
    expect(body.ownerType).toBe("user");
    expect(body.ownerId).toBe("local-user");

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe("local-org");
    expect(rows[0].createdBy).toBe("local-user");
    expect(rows[0].eventKeys).toEqual(["github.pull_request.opened"]);
  });

  it("round-trips a filter's display label; matching ignores it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }]);
    // The label is persisted verbatim in the jsonb, not stripped by the writer.
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual([{ field: "repo", op: "eq", value: "acme/widgets", label: "Widgets repo" }]);
  });

  it("orchestrator target with orchestrator=org writes an org-owned row", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "assistant", assistant: "org" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.ownerType).toBe("org");
    expect(body.ownerId).toBe("local-org");
  });

  it("accepts a trailing-wildcard pattern that matches catalog entries", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["github.pull_request.*"] });
    expect(res.status).toBe(201);
  });

  it("201s a workflow target owned by the caller's org", async () => {
    const a = await boot();
    const wfRes = await fetch(`${a.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "wf",
        definition: {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "stop", type: "stop" },
          ],
          edges: [{ from: "trigger", to: "stop" }],
        },
      }),
    });
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string };

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: wf.id },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a workflow target owned by a DIFFERENT user in the same org — this route must not bypass createWorkflowTrigger's ownership check", async () => {
    const a = await boot();
    const wfRes = await fetch(`${a.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "someone-elses-workflow",
        definition: {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "stop", type: "stop" },
          ],
          edges: [{ from: "trigger", to: "stop" }],
        },
      }),
    });
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string; ownerId: string };
    // The workflow is created with no auth header, so it's owned by the
    // default stub identity ("local-user"), not "test-member" — pin that
    // here so the 400 below is provably a cross-user rejection, not a
    // vacuous pass from the two identities accidentally coinciding.
    expect(wf.ownerId).toBe("local-user");

    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "workflow", workflowId: wf.id } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
  });

  it("400s an empty eventKeys array", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("eventKeys");
  });

  it("400s an unknown event key, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["github.nope.opened"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("github.nope.opened");
  });

  it("400s a wildcard pattern that matches nothing, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, eventKeys: ["linear.*"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("linear.*");
  });

  it("400s a filter field no catalog entry declares, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "nonsense", op: "eq", value: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nonsense");
  });

  it("400s a filter field declared only by a service the eventKeys don't select", async () => {
    // `repo` is a GitHub catalog field; a linear-only subscription using it
    // would validate against the cross-service union and then never match
    // anything at ingest (filtersMatch only consults the arriving event's
    // own entry). Must be rejected, not silently inert.
    api = await bootTestApi({ plugins: [githubPlugin, linearPlugin] });
    const res = await postSubscription(api.baseUrl, {
      ...VALID_BODY,
      eventKeys: ["linear.issue.*"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");

    // Sanity: the same filter is fine when the eventKeys DO select github.
    const ok = await postSubscription(api.baseUrl, VALID_BODY);
    expect(ok.status).toBe(201);
  });

  it("400s a signal target (no workflow node parks on event signals yet)", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "signal" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("signal");
  });

  it("400s a bad filter op, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "matches", value: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("matches");
  });

  it("400s a catastrophic-backtracking regex pattern, with a fix hint", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "regex", value: "(a+)+" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nests");
  });

  it("400s a filter with missing/empty value for op eq, naming the field", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "eq", value: "" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");
  });

  it("400s a filter with a string value for op in (must be array), naming the field", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "in", value: "acme/widgets" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("repo");
  });

  it("400s an unknown target kind", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "webhook" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("target");
  });

  it("400s a workflow target with no workflowId", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "workflow" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("workflowId");
  });

  it("400s a workflow target owned by another org", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_foreign",
      orgId: "other-org",
      ownerType: "user",
      ownerId: "someone",
      name: "foreign",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: "wf_foreign" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("workflow");
  });

  it("files a team workflow's subscription with the team, not the creator", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "t_eng", orgId: "local-org", name: "Eng", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "t_eng", userId: "local-user", role: "member" });
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_team",
      orgId: "local-org",
      ownerType: "team",
      ownerId: "t_eng",
      name: "team workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "workflow", workflowId: "wf_team" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    // The owner names the WORKSPACE the automation belongs to. Stamping the
    // creator filed a team workflow's trigger in a personal workspace, where
    // the team that owns the workflow could not see it.
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe("t_eng");

    // Who armed it is still recorded, on its own column.
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].createdBy).toBe("local-user");
  });

  it("400s a missing name", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, name: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("name");
  });
});

// Visibility reversed on 2026-08-24 (small-fixes design, decision 1): the
// list used to be org-wide for every caller, and the page now names the
// workspace switcher's owner. An owner narrows to that owner's rows PLUS
// the org's own, which belong to every workspace. An unscoped call keeps
// the old answer, so both behaviors are pinned here.
describe("GET /api/event-subscriptions", () => {
  it("with no owner, lists every subscription in the caller's org", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["a colleague's", "pr opens"]);
  });

  it("with the caller's own owner, lists only the caller's subscriptions", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    // Same org, another member — the row the old org-wide list showed and
    // the scoped list must not.
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].name).toBe("pr opens");
  });

  it("with a team owner, lists that team's subscriptions only", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_team", "local-org", {
      name: "team automation",
      ownerType: "team",
      ownerId: "t_eng",
    });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=team&ownerId=t_eng`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].name).toBe("team automation");
  });

  // An org-owned subscription has no workspace of its own. If the owner
  // filter excluded it, the create dialog's "Notify the org assistant"
  // option would write a row that appears in no list and can never be
  // disabled from the UI, while it keeps firing on every matching webhook.
  it("lists org-owned subscriptions in the personal workspace too", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      name: "org watch",
      target: { kind: "assistant", assistant: "org" },
    });
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_mine", "local-org", { name: "mine", ownerId: "local-user" });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["mine", "org watch"]);
  });

  it("lists org-owned subscriptions in a team workspace too", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      name: "org watch",
      target: { kind: "assistant", assistant: "org" },
    });
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_team", "local-org", {
      name: "team automation",
      ownerType: "team",
      ownerId: "t_eng",
    });
    await seedSubscriptionRow(a, "sub_colleague", "local-org", { name: "a colleague's" });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=team&ownerId=t_eng`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions.map((s) => s.name).sort()).toEqual(["org watch", "team automation"]);
  });

  it("keeps another org's org-owned rows out of the union", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign_org", "other-org", {
      name: "another org's",
      ownerType: "org",
      ownerId: "other-org",
    });

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(0);
  });

  it("400s a half-specified owner pair, naming both parameters", async () => {
    const a = await boot();

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions?ownerType=user`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(HALF_FILTER_ERROR);
  });
});

// Spec 2026-10-16 presence hub, Part C step 5: a rule whose pinned thread no
// longer accepts deliveries carries a problem, read from its deliveries.
describe("GET /api/event-subscriptions problem", () => {
  const PIN_TEXT = "Pick another thread in Presence.";

  async function seedDelivery(
    a: TestApi,
    id: string,
    subscriptionId: string,
    over: { status: "dead" | "delivered" | "failed"; lastError?: string; createdAt: number },
  ): Promise<void> {
    await a.providers.db.insert(eventDeliveries).values({
      id, eventId: `ev_${id}`, subscriptionId, status: over.status, attempts: 1,
      lastError: over.lastError ?? null, nextAttemptAt: over.createdAt, createdAt: over.createdAt,
    });
  }

  async function problems(a: TestApi): Promise<Record<string, string | undefined>> {
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    return Object.fromEntries(body.subscriptions.map((s) => [s.id, s.problem]));
  }

  it("sets the problem when the latest delivery dead-lettered on the pin", async () => {
    const a = await boot();
    const later = Date.now() + 60_000;
    await seedSubscriptionRow(a, "sub_pin", "local-org");
    await seedDelivery(a, "d_old_ok", "sub_pin", { status: "delivered", createdAt: later });
    await seedDelivery(a, "d_pin", "sub_pin", { status: "dead", lastError: PIN_TEXT, createdAt: later + 1 });
    expect((await problems(a)).sub_pin).toBe(PIN_TEXT);
  });

  // A delivery dead-lettered before the pin text changed keeps the old text.
  it("sets the problem for a dead-letter with the old pin text", async () => {
    const a = await boot();
    const later = Date.now() + 60_000;
    const legacy = "Pick another thread for this rule in Presence.";
    await seedSubscriptionRow(a, "sub_legacy", "local-org");
    await seedDelivery(a, "d_legacy", "sub_legacy", { status: "dead", lastError: legacy, createdAt: later });
    expect((await problems(a)).sub_legacy).toBe(legacy);
  });

  it("leaves the problem absent for other dead-letters, a later delivery, and an edit after it", async () => {
    const a = await boot();
    const later = Date.now() + 60_000;
    await seedSubscriptionRow(a, "sub_other", "local-org");
    await seedDelivery(a, "d_boom", "sub_other", { status: "dead", lastError: "boom", createdAt: later });
    await seedSubscriptionRow(a, "sub_recovered", "local-org");
    await seedDelivery(a, "d_pin_then", "sub_recovered", { status: "dead", lastError: PIN_TEXT, createdAt: later });
    await seedDelivery(a, "d_ok_now", "sub_recovered", { status: "delivered", createdAt: later + 1 });
    // A pending retry after the dead-letter is not a settled answer yet.
    await seedSubscriptionRow(a, "sub_retrying", "local-org");
    await seedDelivery(a, "d_pin_r", "sub_retrying", { status: "dead", lastError: PIN_TEXT, createdAt: later });
    await seedDelivery(a, "d_retry", "sub_retrying", { status: "failed", lastError: "boom", createdAt: later + 1 });
    // A dead-letter older than the rule's last edit predates the fix.
    await seedSubscriptionRow(a, "sub_edited", "local-org");
    await seedDelivery(a, "d_pin_old", "sub_edited", { status: "dead", lastError: PIN_TEXT, createdAt: 1_000 });
    await seedSubscriptionRow(a, "sub_quiet", "local-org");

    const got = await problems(a);
    expect(got.sub_other).toBeUndefined();
    expect(got.sub_recovered).toBeUndefined();
    expect(got.sub_retrying).toBe(PIN_TEXT);
    expect(got.sub_edited).toBeUndefined();
    expect(got.sub_quiet).toBeUndefined();
    expect(Object.keys(got).sort()).toEqual(["sub_edited", "sub_other", "sub_quiet", "sub_recovered", "sub_retrying"]);
  });
});

// Spec 2026-10-16 presence hub, Part C step 4: the listener page lists the
// rule's own deliveries.
describe("GET /api/event-subscriptions/:id/deliveries", () => {
  it("lists one rule's deliveries newest first, each with its event", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_mine", "local-org");
    await seedSubscriptionRow(a, "sub_other", "local-org");
    await seedEventRow(a, { id: "ev_a", receivedAt: 1_000 });
    await seedEventRow(a, { id: "ev_b", receivedAt: 2_000 });
    await a.providers.db.insert(eventDeliveries).values([
      { id: "d_a", eventId: "ev_a", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 1_000, deliveredAt: 1_100, createdAt: 1_000 },
      { id: "d_b", eventId: "ev_b", subscriptionId: "sub_mine", status: "dead", attempts: 1, lastError: "Pick another thread in Presence.", nextAttemptAt: 2_000, createdAt: 2_000 },
      { id: "d_other", eventId: "ev_a", subscriptionId: "sub_other", status: "delivered", attempts: 1, nextAttemptAt: 1_000, createdAt: 1_000 },
    ]);

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_mine/deliveries`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSubscriptionDeliveriesResponse;
    expect(body.deliveries.map((d) => [d.id, d.event.id, d.event.summary])).toEqual([
      ["d_b", "ev_b", "event ev_b"],
      ["d_a", "ev_a", "event ev_a"],
    ]);
    expect(body.deliveries[0]).toMatchObject({ status: "dead", lastError: "Pick another thread in Presence.", nextAttemptAt: null });
  });

  it("404s a rule in another org and 400s a bad limit", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");
    await seedSubscriptionRow(a, "sub_here", "local-org");
    expect((await fetch(`${a.baseUrl}/api/event-subscriptions/sub_foreign/deliveries`)).status).toBe(404);
    expect((await fetch(`${a.baseUrl}/api/event-subscriptions/sub_here/deliveries?limit=0`)).status).toBe(400);
  });
});

// Spec 2026-10-16 presence hub, Part D step 4: a line's Activity merges its
// deliveries and the receipt decisions that skipped it.
describe("GET /api/event-subscriptions/:id/activity", () => {
  const MEMBER = { "x-valet-test-user-id": "test-member" };

  async function seedReceipt(
    a: TestApi, id: string, createdAt: number,
    decision: { outcome: string; failedFilters?: Array<{ field: string; op: string }> }, eventId: string | null = null,
  ): Promise<void> {
    await a.providers.db.insert(eventReceipts).values({
      id, orgId: "local-org", service: "github", externalId: null, metadata: {}, stages: [],
      eventKey: "github.pull_request.opened", eventId, createdAt, updatedAt: createdAt,
      subscriptions: [{ id: "sub_line", ownerType: "user", ownerId: "someone", target: "assistant", ...decision }],
    });
  }

  async function activity(a: TestApi, query = "", headers: Record<string, string> = {}): Promise<LineActivityResponse> {
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_line/activity${query}`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as LineActivityResponse;
  }

  it("lists acted and skipped entries newest first, with tookMs and the reason", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_line", "local-org", { filters: [{ field: "repo", op: "eq", value: "acme/widgets" }] });
    await seedEventRow(a, { id: "ev_a", receivedAt: 1_000, subjects: ["github:acme/widgets"] });
    await a.providers.db.insert(eventDeliveries).values([
      { id: "d_a", eventId: "ev_a", subscriptionId: "sub_line", status: "delivered", attempts: 1, nextAttemptAt: 1_000, deliveredAt: 1_250, createdAt: 1_000 },
    ]);
    await seedReceipt(a, "r_filter", 2_000, { outcome: "filter_excluded", failedFilters: [{ field: "repo", op: "eq" }] });
    await seedReceipt(a, "r_matched", 3_000, { outcome: "matched" });

    const body = await activity(a);
    expect(body.entries.map((e) => [e.id, e.kind])).toEqual([["receipt:r_filter", "skipped"], ["d_a", "acted"]]);
    expect(body.entries[1]).toMatchObject({ eventId: "ev_a", place: "github:acme/widgets", placeLabel: "acme/widgets", tookMs: 250, outcome: { status: "delivered" } });
    // An admin sees a skip whose place is unknown; this receipt names no stored event.
    expect(body.entries[0]).toMatchObject({ reason: "filters", reasonText: "the repository filter", eventId: null });
    expect(body.lastActedAt).toBe(1_250);
    expect(body.nextCursor).toBeUndefined();
  });

  // Review Focus 1.
  it("shows a member skipped entries only in the line's places", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_line", "local-org", { filters: [{ field: "repo", op: "eq", value: "acme/widgets" }] });
    await seedEventRow(a, { id: "ev_in", receivedAt: 1_000, subjects: ["github:acme/widgets#7"] });
    await seedEventRow(a, { id: "ev_out", receivedAt: 1_000, subjects: ["github:acme/other"] });
    await seedReceipt(a, "r_in", 1_000, { outcome: "authorization_denied" }, "ev_in");
    await seedReceipt(a, "r_out", 2_000, { outcome: "disabled" }, "ev_out");
    await seedReceipt(a, "r_unknown", 3_000, { outcome: "key_mismatch" });

    const member = await activity(a, "", MEMBER);
    expect(member.entries.map((e) => e.id)).toEqual(["receipt:r_in"]);
    const admin = await activity(a);
    expect(admin.entries.map((e) => [e.id, e.reason])).toEqual([
      ["receipt:r_unknown", "other"], ["receipt:r_out", "off"], ["receipt:r_in", "sender"],
    ]);
  });

  it("counts delivered entries per UTC day for 30 days", async () => {
    const a = await boot();
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await seedSubscriptionRow(a, "sub_line", "local-org");
    await seedEventRow(a, { id: "ev_a", receivedAt: now });
    const rows = [
      { id: "d_29", at: now - 29 * day, status: "delivered" as const },
      { id: "d_31", at: now - 31 * day, status: "delivered" as const },
      { id: "d_now", at: now, status: "delivered" as const },
      { id: "d_dead", at: now, status: "dead" as const },
    ];
    await a.providers.db.insert(eventDeliveries).values(rows.map((r) => ({
      id: r.id, eventId: "ev_a", subscriptionId: "sub_line", status: r.status, attempts: 1, nextAttemptAt: r.at,
      deliveredAt: r.status === "delivered" ? r.at : null, createdAt: r.at,
    })));
    const body = await activity(a);
    expect(body.perDay).toHaveLength(30);
    expect(body.perDay[0]).toBe(1);
    expect(body.perDay[29]).toBe(1);
    expect(body.actedLast30Days).toBe(2);
    expect(body.lastActedAt).toBe(now);
  });

  it("pages through both sources with the before cursor", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_line", "local-org");
    await seedEventRow(a, { id: "ev_a", receivedAt: 1_000 });
    for (let i = 0; i < 5; i++) {
      await a.providers.db.insert(eventDeliveries).values({
        id: `d_${i}`, eventId: "ev_a", subscriptionId: "sub_line", status: "delivered", attempts: 1,
        nextAttemptAt: 1_000, deliveredAt: 1_000 + i * 20 + 5, createdAt: 1_000 + i * 20,
      });
      await seedReceipt(a, `r_${i}`, 1_010 + i * 20, { outcome: "filter_excluded" });
    }
    const seen: string[] = [];
    let query = "?limit=3";
    for (let page = 0; page < 5; page++) {
      const body = await activity(a, query);
      seen.push(...body.entries.map((e) => e.id));
      if (!body.nextCursor) break;
      query = `?limit=3&before=${body.nextCursor}`;
    }
    expect(seen).toEqual([
      "receipt:r_4", "d_4", "receipt:r_3", "d_3", "receipt:r_2", "d_2", "receipt:r_1", "d_1", "receipt:r_0", "d_0",
    ]);
    expect((await fetch(`${a.baseUrl}/api/event-subscriptions/sub_line/activity?before=bad`)).status).toBe(400);
  });

  it("keeps a short source's older rows when the other source fills a batch", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_line", "local-org", { filters: [{ field: "repo", op: "eq", value: "acme/widgets" }] });
    await seedEventRow(a, { id: "ev_a", receivedAt: 1, subjects: ["github:acme/widgets"] });
    await a.providers.db.insert(eventDeliveries).values([1, 2].map((at) => ({
      id: `d_${at}`, eventId: "ev_a", subscriptionId: "sub_line", status: "delivered" as const, attempts: 1,
      nextAttemptAt: at, deliveredAt: at, createdAt: at,
    })));
    // A member may not see these skips (their place is unknown), so one read
    // scans past a full batch of them to reach the older deliveries.
    for (let i = 0; i < 6; i++) await seedReceipt(a, `r_${i}`, 100 + i, { outcome: "disabled" });
    const body = await activity(a, "?limit=3", MEMBER);
    expect(body.entries.map((e) => e.id)).toEqual(["d_2", "d_1"]);
    expect(body.nextCursor).toBeUndefined();
  });

  it("404s a missing line with text that names the fix", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");
    for (const id of ["sub_missing", "sub_foreign"]) {
      const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${id}/activity`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This line was not found. Refresh Presence and try again." });
    }
  });
});

describe("PATCH /api/event-subscriptions/:id", () => {
  it("updates name/enabled/filters and re-validates what's provided", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", enabled: false, filters: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    expect(body.name).toBe("renamed");
    expect(body.enabled).toBe(false);
    expect(body.filters).toEqual([]);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].name).toBe("renamed");
  });

  it("400s patched eventKeys with an unknown key", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventKeys: ["github.bogus"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("github.bogus");
  });

  it("404s a subscription in another org", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_foreign`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("404s a colleague's personal subscription in the SAME org, row unchanged", async () => {
    const a = await boot();
    // seedSubscriptionRow's row is ownerType "user"/ownerId "someone" —
    // neither the default caller ("local-user") nor "test-member" below.
    await seedSubscriptionRow(a, "sub_colleague", "local-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_colleague`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);

    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, "sub_colleague"));
    expect(rows[0].enabled).toBe(true);
  });

  it("an org-owned subscription is mutable by any org member", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "assistant", assistant: "org" } })
    ).json()) as CreateEventSubscriptionResponse;
    expect(created.ownerType).toBe("org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/event-subscriptions/:id", () => {
  it("204s and removes the row", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, VALID_BODY)).json()) as CreateEventSubscriptionResponse;

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows).toHaveLength(0);
  });

  it("404s a subscription in another org (row survives)", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_foreign`, { method: "DELETE" });
    expect(res.status).toBe(404);

    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_foreign"));
    expect(rows).toHaveLength(1);
  });

  it("404s a colleague's personal subscription in the SAME org, row survives", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_colleague", "local-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_colleague`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);

    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, "sub_colleague"));
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/events/:id", () => {
  it("returns the event with its deliveries", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_1", "local-org");
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_1",
      eventId: "ev_1",
      subscriptionId: "sub_1",
      status: "failed",
      attempts: 2,
      lastError: "boom",
      nextAttemptAt: 5_000,
      createdAt: 1_000,
    });

    const res = await fetch(`${a.baseUrl}/api/events/ev_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetEventResponse;
    expect(body.event.id).toBe("ev_1");
    expect(body.event.payload).toEqual({ repository: { full_name: "acme/widgets" } });
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({
      subscriptionId: "sub_1",
      status: "failed",
      attempts: 2,
      lastError: "boom",
    });
    // A failing delivery must say WHEN it retries and WHAT it is trying to
    // reach; without both, it reads the same as a dead one.
    expect(body.deliveries[0].nextAttemptAt).toBe(5_000);
    expect(body.deliveries[0].subscriptionName).toBe("seeded sub_1");
  });

  it("reports no next attempt for a delivery that gave up", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_dead", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_dead", "local-org", { name: "PR reviewer" });
    // A dead row keeps the `next_attempt_at` of the attempt that gave up, so
    // shipping the column raw would promise a retry that never comes.
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_dead",
      eventId: "ev_dead",
      subscriptionId: "sub_dead",
      status: "dead",
      attempts: 4,
      lastError: "Error: connect ECONNREFUSED 127.0.0.1:8788",
      nextAttemptAt: 9_000,
      createdAt: 1_000,
    });

    const res = await fetch(`${a.baseUrl}/api/events/ev_dead`);
    const body = (await res.json()) as GetEventResponse;
    expect(body.deliveries[0].status).toBe("dead");
    expect(body.deliveries[0].nextAttemptAt).toBeNull();
    expect(body.deliveries[0].subscriptionName).toBe("PR reviewer");
    // The error is the one field a reader needs whole.
    expect(body.deliveries[0].lastError).toBe("Error: connect ECONNREFUSED 127.0.0.1:8788");
  });

  it("404s an event belonging to another org", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 1_000 });

    const res = await fetch(`${a.baseUrl}/api/events/ev_foreign`);
    expect(res.status).toBe(404);
  });

  /** One event with an assistant delivery admitted to the caller's own
   * assistant thread, a workflow delivery whose run started, and a dead
   * workflow delivery that started nothing. */
  async function seedDestinations(a: TestApi): Promise<{ sessionId: string; threadId: string }> {
    await seedEventRow(a, { id: "ev_dest", receivedAt: 1_000 });
    const owner = { ownerType: "user" as const, ownerId: "local-user" };
    await seedSubscriptionRow(a, "sub_assist", "local-org", { ...owner, name: "Triage" });
    await seedSubscriptionRow(a, "sub_wf", "local-org", { ...owner, target: { kind: "workflow", workflowId: "wf_dest" } });
    await seedWorkflowRow(a, "wf_dest");
    const delivered = { eventId: "ev_dest", attempts: 1, nextAttemptAt: 1_000, createdAt: 1_000 };
    await a.providers.db.insert(eventDeliveries).values([
      { ...delivered, id: "del_assist", subscriptionId: "sub_assist", status: "delivered", deliveredAt: 2_000 },
      { ...delivered, id: "del_wf", subscriptionId: "sub_wf", status: "delivered", deliveredAt: 2_000 },
      { ...delivered, id: "del_wf_dead", subscriptionId: "sub_wf", status: "dead", lastError: "boom" },
    ]);
    // The thread is paused, so the admitted delivery waits in the queue and
    // no model runs.
    const session = await defaultAssistantSessionFor(a.providers, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
    const thread = session.thread("events");
    await thread.pause();
    await thread.submitPrompt(
      { kind: "signal", signalType: "github.pull_request.opened", body: "event ev_dest" },
      { dispatchId: eventDeliveryDispatchId("del_assist") },
    );
    const definition = { version: "dag/v1" as const, nodes: [], edges: [] };
    await a.providers.workflowStore.createRun(eventDeliveryRunId("del_wf"), { workflowId: "wf_dest", definitionVersionId: "v1" }, definition, "v1", owner);
    return { sessionId: session.id, threadId: thread.id };
  }

  it("links an assistant delivery to its thread and a workflow delivery to its run", async () => {
    const a = await boot();
    const thread = await seedDestinations(a);

    const body = (await (await fetch(`${a.baseUrl}/api/events/ev_dest`)).json()) as GetEventResponse;
    const byId = new Map(body.deliveries.map((d) => [d.id, d]));
    expect(byId.get("del_assist")?.thread).toEqual(thread);
    expect(byId.get("del_assist")?.runId).toBeUndefined();
    expect(byId.get("del_wf")?.runId).toBe(eventDeliveryRunId("del_wf"));
    expect(byId.get("del_wf")?.thread).toBeUndefined();
    // A delivery that started no run links nowhere.
    expect(byId.get("del_wf_dead")?.runId).toBeUndefined();
  });

  it("links a claimed delivery to the thread that claimed it, for a viewer who may open it (Part E step 2)", async () => {
    const a = await boot();
    const thread = await seedDestinations(a);
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_claimed", eventId: "ev_dest", subscriptionId: "sub_assist", status: "skipped", attempts: 1, nextAttemptAt: 1_000, createdAt: 1_000,
      lastError: `Skipped, claimed by thread ${thread.threadId}.`, destination: { kind: "skip", reason: `claimed by thread ${thread.threadId}` },
    });

    const body = (await (await fetch(`${a.baseUrl}/api/events/ev_dest`)).json()) as GetEventResponse;
    const claimed = body.deliveries.find((d) => d.id === "del_claimed");
    expect(claimed?.claimedBy).toEqual(thread);
    expect(claimed?.thread).toBeUndefined();
    expect(body.deliveries.find((d) => d.id === "del_assist")?.claimedBy).toBeUndefined();

    const other = (await (await fetch(`${a.baseUrl}/api/events/ev_dest`, { headers: { "x-valet-test-user-id": "test-member" } })).json()) as GetEventResponse;
    const hidden = other.deliveries.find((d) => d.id === "del_claimed");
    expect(hidden?.claimedBy).toBeUndefined();
    expect(hidden?.lastError).toBe("Skipped, claimed by another thread.");
  });

  it("names a claiming thread's title and keeps the claim after the thread is archived (presence hub Review Focus 4)", async () => {
    const a = await boot();
    const thread = await seedDestinations(a);
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_claimed", eventId: "ev_dest", subscriptionId: "sub_assist", status: "skipped", attempts: 1, nextAttemptAt: 1_000, createdAt: 1_000,
      lastError: `Skipped, claimed by thread ${thread.threadId}.`, destination: { kind: "skip", reason: `claimed by thread ${thread.threadId}` },
    });
    const patch = (body: object) => fetch(`${a.baseUrl}/api/threads/${thread.threadId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await patch({ title: "t-inc" })).status).toBe(200);
    const read = async () => ((await (await fetch(`${a.baseUrl}/api/events/ev_dest`)).json()) as GetEventResponse).deliveries;

    const live = await read();
    expect(live.find((d) => d.id === "del_claimed")?.claimedBy).toEqual({ ...thread, title: "t-inc" });
    expect(live.find((d) => d.id === "del_assist")?.thread).toEqual({ ...thread, title: "t-inc" });

    // The thread holds a queued delivery, so the archive route refuses it;
    // stamp the archive time the way the route does.
    await a.providers.db.update(sessionThreads).set({ archivedAt: Date.now() })
      .where(and(eq(sessionThreads.sessionId, thread.sessionId), eq(sessionThreads.id, thread.threadId)));
    const archived = await read();
    expect(archived.find((d) => d.id === "del_claimed")?.claimedBy).toEqual({ ...thread, title: "t-inc", archived: true });
  });

  it("withholds a hidden claiming thread's title from another member's Log", async () => {
    const a = await boot();
    const thread = await seedDestinations(a);
    // An org rule shows in every workspace's Log; its delivery was claimed
    // by the owner's personal thread.
    await seedSubscriptionRow(a, "sub_org", "local-org", { ownerType: "org", ownerId: "local-org", name: "Org triage" });
    // The Log looks back 30 days, so this event is recent.
    await seedEventRow(a, { id: "ev_recent", receivedAt: Date.now() });
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_org_claimed", eventId: "ev_recent", subscriptionId: "sub_org", status: "skipped", attempts: 1, nextAttemptAt: 1_000, createdAt: 1_000,
      lastError: `Skipped, claimed by thread ${thread.threadId}.`, destination: { kind: "skip", reason: `claimed by thread ${thread.threadId}` },
    });
    const patched = await fetch(`${a.baseUrl}/api/threads/${thread.threadId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "secret incident" }),
    });
    expect(patched.status).toBe(200);
    const logFor = async (userId: string) => (await (await fetch(`${a.baseUrl}/api/events/log?ownerType=user&ownerId=${userId}`,
      { headers: { "x-valet-test-user-id": userId } })).json()) as EventLogResponse;

    const own = (await logFor("local-user")).items.find((item) => item.id === "ev_recent");
    expect(own?.deliveries?.find((d) => d.id === "del_org_claimed")?.claimedBy).toEqual({ ...thread, title: "secret incident" });

    const other = await logFor("test-member");
    const row = other.items.find((item) => item.id === "ev_recent");
    const claimed = row?.deliveries?.find((d) => d.id === "del_org_claimed");
    expect(claimed).toBeDefined();
    expect(claimed?.claimedBy).toBeUndefined();
    expect(claimed?.lastError).toBe("Skipped, claimed by another thread.");
    expect(JSON.stringify(other)).not.toContain("secret incident");
    expect(JSON.stringify(other)).not.toContain(thread.threadId);
  });

  it("omits the thread and the run for a viewer who may not open them", async () => {
    const a = await boot();
    await seedDestinations(a);

    // The event and its deliveries are org-visible, but the thread and the
    // run belong to another member's personal workspace.
    const res = await fetch(`${a.baseUrl}/api/events/ev_dest`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetEventResponse;
    expect(body.deliveries).toHaveLength(3);
    for (const delivery of body.deliveries) {
      expect(delivery.thread).toBeUndefined();
      expect(delivery.runId).toBeUndefined();
    }
  });

  it("links a personal thread to a member while its owner shares it", async () => {
    const a = await boot();
    const thread = await seedDestinations(a);
    const member = { "x-valet-test-user-id": "test-member" };
    const threadFor = async () => {
      const body = (await (await fetch(`${a.baseUrl}/api/events/ev_dest`, { headers: member })).json()) as GetEventResponse;
      return body.deliveries.find((d) => d.id === "del_assist")?.thread;
    };
    const share = (mode: string) => fetch(`${a.baseUrl}/api/threads/${thread.threadId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ share: mode }),
    });

    // Without a share, the member cannot open the owner's thread.
    expect(await threadFor()).toBeUndefined();
    expect((await fetch(`${a.baseUrl}/api/threads/${thread.threadId}`, { headers: member })).status).toBe(404);

    // A share admits every member of the organization at /threads/:threadId,
    // so the event page links the thread for them too.
    expect((await share("view")).status).toBe(200);
    expect((await fetch(`${a.baseUrl}/api/threads/${thread.threadId}`, { headers: member })).status).toBe(200);
    expect(await threadFor()).toEqual(thread);

    // When the owner turns the share off, the link goes away with the access.
    expect((await share("off")).status).toBe(200);
    expect(await threadFor()).toBeUndefined();
  });
});

// ── Redelivery ──────────────────────────────────────────────────────────────

/** Records the run ids the dispatcher starts, and never runs anything. The
 * recorded ids are the point: the dispatcher derives a run id from the
 * delivery id (`wfrun_evt_${deliveryId}`) and returns early when that run
 * exists, so a redelivery that reused a delivery id would report success and
 * start nothing. */
function recordingRunHost(): { host: RunHost; started: string[] } {
  const started: string[] = [];
  return {
    started,
    host: {
      start: async (runId: string) => {
        started.push(runId);
      },
      wake: async () => {},
      scheduleWake: async () => {},
      terminate: async () => {},
      startHost: () => {},
      stopHost: async () => {},
    },
  };
}

async function seedWorkflowRow(a: TestApi, id: string): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    ownerType: "user",
    ownerId: "local-user",
    name: `workflow ${id}`,
    definition: { version: "dag/v1", nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  });
}

async function deliveriesFor(a: TestApi, eventId: string) {
  return a.providers.db.select().from(eventDeliveries).where(eq(eventDeliveries.eventId, eventId));
}

async function redeliver(baseUrl: string, eventId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/events/${eventId}/redeliver`, { method: "POST" });
}

describe("POST /api/events/:id/redeliver", () => {
  /** Workflow targets on a recording run host: a redelivery dispatches for
   * real, without a live workflow engine in a route test. */
  async function bootWithRunHost(): Promise<{ a: TestApi; started: string[] }> {
    const { host, started } = recordingRunHost();
    api = await bootTestApi({ plugins: [githubPlugin], workflowRunHost: host });
    return { a: api, started };
  }

  it("creates NEW delivery rows and dispatches them, leaving the dead row intact", async () => {
    const { a, started } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_1", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });
    // The 9am attempt that gave up.
    await a.providers.db.insert(eventDeliveries).values({
      id: "del_dead",
      eventId: "ev_1",
      subscriptionId: "sub_1",
      status: "dead",
      attempts: 4,
      lastError: "workflow wf_redeliver not found in org local-org",
      nextAttemptAt: 2_000,
      createdAt: 1_000,
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect(res.status).toBe(200);
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 1 });

    const rows = await deliveriesFor(a, "ev_1");
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== "del_dead");
    expect(fresh).toBeDefined();

    // The dispatcher must start a run under the NEW delivery id. A reused id
    // would resolve to `wfrun_evt_del_dead` and be swallowed by the
    // already-exists early return. (The route nudges the dispatcher, so the
    // delivery may already be done here; this poll covers both orderings.)
    await a.providers.eventDispatcher.pollOnce();
    await expect.poll(() => started, { timeout: 5_000 }).toEqual([`wfrun_evt_${fresh!.id}`]);

    // The dead row is the record of what happened; it is never revived.
    const settled = await deliveriesFor(a, "ev_1");
    expect(settled.find((r) => r.id === "del_dead")).toMatchObject({ status: "dead", attempts: 4 });
    expect(settled.find((r) => r.id === fresh!.id)?.status).toBe("delivered");
  });

  it("targets the subscriptions matching NOW: skips disabled, includes one created after the event", async () => {
    const { a } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    // Deliberately switched off — the owner does not want this event.
    await seedSubscriptionRow(a, "sub_off", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
      enabled: false,
    });
    // Created after the event, and repaired — the owner does want it.
    await seedSubscriptionRow(a, "sub_fixed", "local-org", {
      eventKeys: ["github.pull_request.*"],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 1 });
    const rows = await deliveriesFor(a, "ev_1");
    expect(rows.map((r) => r.subscriptionId)).toEqual(["sub_fixed"]);
  });

  it("applies the subscription filters, not just the event key", async () => {
    const { a } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    // seedEventRow's payload is repository acme/widgets.
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_other_repo", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/other" }],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 0 });
    expect(await deliveriesFor(a, "ev_1")).toHaveLength(0);
  });

  it("honors a subject filter: redelivers only to the subscription whose subject matches (spec Part G)", async () => {
    const { a } = await bootWithRunHost();
    await seedWorkflowRow(a, "wf_redeliver");
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000, subjects: ["github:acme", "github:acme/widgets"] });
    await seedSubscriptionRow(a, "sub_match", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "subject", op: "eq", value: "github:acme/widgets" }],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });
    await seedSubscriptionRow(a, "sub_miss", "local-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "subject", op: "eq", value: "github:acme/other" }],
      target: { kind: "workflow", workflowId: "wf_redeliver" },
    });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 1 });
    const rows = await deliveriesFor(a, "ev_1");
    expect(rows.map((r) => r.subscriptionId)).toEqual(["sub_match"]);
  });

  it("200s with created 0 when nothing matches, so the UI can say so", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_1", receivedAt: 1_000 });

    const res = await redeliver(a.baseUrl, "ev_1");
    expect(res.status).toBe(200);
    expect((await res.json()) as RedeliverEventResponse).toEqual({ created: 0 });
  });

  it("404s an event in another org and writes nothing", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 1_000 });
    await seedSubscriptionRow(a, "sub_foreign", "other-org", {
      eventKeys: ["github.pull_request.opened"],
    });

    const res = await redeliver(a.baseUrl, "ev_foreign");
    expect(res.status).toBe(404);
    expect(await deliveriesFor(a, "ev_foreign")).toHaveLength(0);
  });
});

/**
 * A team owns event subscriptions the same way it owns workflows, skills and
 * sessions: the subscription names the TEAM as owner, and the dispatcher
 * delivers into that team's default assistant rather than the assistant of
 * whichever member happened to create it.
 *
 * Membership is the bar to create one, matching team workflows and team
 * sessions — a member who can start a team workflow by hand can equally
 * arrange for an event to start it. A caller who is not on the team gets 404,
 * never 403, so a subscription never confirms a team's existence.
 */
describe("event subscriptions — team ownership", () => {
  async function bootWithTeam(): Promise<TestApi> {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });
    // A second team the caller is NOT on, to prove the refusal below is about
    // membership and not about the id being unknown.
    await a.providers.db.insert(teams).values({ id: "team_2", orgId: "local-org", name: "Other", createdAt: now });
    return a;
  }

  const teamBody: CreateEventSubscriptionRequest = {
    ...VALID_BODY,
    target: { kind: "assistant", assistant: "team", teamId: "team_1" },
  };

  it("stamps a team target with the TEAM as owner, not the creating member", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateEventSubscriptionResponse;
    expect(created.ownerType).toBe("team");
    expect(created.ownerId).toBe("team_1");
    expect(created.ownerId).not.toBe("test-member");
    // The row agrees with the response — the owner is persisted, not just
    // reported, because the dispatcher reads the row and never the response.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0]?.ownerType).toBe("team");
    expect(rows[0]?.ownerId).toBe("team_1");
    // `createdBy` still records the human, which is what the dispatcher hands
    // the engine as the actor — a team id is not a user.
    expect(rows[0]?.createdBy).toBe("test-member");
  });

  it("404s a team the caller is not a member of, without naming it", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "assistant", assistant: "team", teamId: "team_2" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("team not found");
    expect(body.error).not.toContain("Other");
  });

  // `deleteTeam` deletes a team's own event_subscriptions rows under
  // `lockTeamForOwnership` (services/teams.ts). An insert that already
  // passed its membership/ownership checks before the delete's transaction
  // commits, but writes after, lands as an orphan pointing at a team (or
  // workflow) that no longer exists — the same race #709 closed for
  // schedules. These two tests force that race deterministically by
  // deleting the target from inside the pre-insert check's mock
  // implementation, which still calls through to the real check first.
  it("does not leave an orphaned subscription when the team is deleted between the membership check and the insert", async () => {
    const a = await bootWithTeam();
    const original = teamsService.isTeamMember;
    const spy = vi.spyOn(teamsService, "isTeamMember").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await deleteTeam(a.providers.db, { teamId: "team_1" });
      return result;
    });
    try {
      const res = await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" });
      expect(res.status).toBe(400);
      expect(await a.providers.db.select().from(eventSubscriptions)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not leave an orphaned subscription when its target workflow is deleted before the insert", async () => {
    const a = await bootWithTeam();
    const now = Date.now();
    await a.providers.db.insert(workflowDefinitions).values({
      id: "wf_team_race",
      orgId: "local-org",
      ownerType: "team",
      ownerId: "team_1",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
    const original = workflowService.armableDefinitionRow;
    const spy = vi.spyOn(workflowService, "armableDefinitionRow").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await a.providers.db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, "wf_team_race"));
      return result;
    });
    try {
      const res = await postSubscription(
        a.baseUrl,
        { ...VALID_BODY, target: { kind: "workflow", workflowId: "wf_team_race" } },
        { "x-valet-test-user-id": "test-member" },
      );
      expect(res.status).toBe(400);
      expect(await a.providers.db.select().from(eventSubscriptions)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("404s a team id that does not exist at all — same answer as one you're not on", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "assistant", assistant: "team", teamId: "team_nope" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(404);
  });

  it("400s a team target with no teamId — it names no team", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "assistant", assistant: "team" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("A team assistant target requires teamId. Choose the team.");
  });

  it("400s a teamId on a user target — it would read as delivering to the team, and does not", async () => {
    const a = await bootWithTeam();
    const res = await postSubscription(
      a.baseUrl,
      { ...VALID_BODY, target: { kind: "assistant", assistant: "user", teamId: "team_1" } },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("teamId is only valid when assistant is team. Remove teamId.");
  });

  it("lets another member of the same team change and delete it", async () => {
    const a = await bootWithTeam();
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-admin", role: "member" });
    const created = (await (
      await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" })
    ).json()) as CreateEventSubscriptionResponse;

    const patched = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as PatchEventSubscriptionResponse).enabled).toBe(false);

    const deleted = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "test-admin" },
    });
    expect(deleted.status).toBe(204);
  });

  it("404s a non-member trying to change or delete a team subscription", async () => {
    const a = await bootWithTeam();
    const created = (await (
      await postSubscription(a.baseUrl, teamBody, { "x-valet-test-user-id": "test-member" })
    ).json()) as CreateEventSubscriptionResponse;

    const patched = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "outsider" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(404);

    const deleted = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "DELETE",
      headers: { "x-valet-test-user-id": "outsider" },
    });
    expect(deleted.status).toBe(404);

    // Still there, and still enabled — the refusal changed nothing.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0]?.enabled).toBe(true);
  });
});

// ── Assistant routing on an orchestrator target ────────────────────────────
//
// A rule may name WHICH of its owner's assistants answers. Absent means the
// owner's default, the behavior every rule had before the field.
describe("event-subscription assistant target", () => {
  async function seedAssistants(a: TestApi): Promise<{ mine: string; foreign: string }> {
    const db = a.providers.db;
    // The first create for a principal takes the default slot.
    await seedWorkspaceAssistant(db, "local-org", { type: "user", id: "local-user" });
    const mine = await seedWorkspaceAssistant(db, "local-org", { type: "user", id: "local-user" });
    const foreign = await seedWorkspaceAssistant(db, "local-org", { type: "user", id: "someone-else" });
    return { mine: mine.id, foreign: foreign.id };
  }

  it("rejects selecting a named assistant", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "to ops",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "assistant", assistant: "user", assistantId: mine },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Choose the personal or team workspace") });
  });

  it("refuses an assistant owned by someone else, without saying it exists", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { foreign } = await seedAssistants(a);

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "nope",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "assistant", assistant: "user", assistantId: foreign },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Same message an id that does not exist gets: existence stays hidden.
    expect(body.error).toContain("Assistant selection is not supported");
  });

  it("rejects assistant routing patches", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);

    const created = (await (
      await fetch(`${a.baseUrl}/api/event-subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "repoint me",
          eventKeys: ["github.pull_request.opened"],
          target: { kind: "assistant", assistant: "user" },
        }),
      })
    ).json()) as { id: string; target: { assistantId?: string } };
    expect(created.target.assistantId).toBeUndefined();

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId: mine }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Assistant selection is not supported") });
    // `null` clears a retired selection, so it is accepted.
    const cleared = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId: null }),
    });
    expect(cleared.status).toBe(200);
  });

  it("lets an owner disable a rule saved with a retired assistant selection", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const now = Date.now();
    await a.providers.db.insert(eventSubscriptions).values({
      id: "legacy-assistant-rule", orgId: "local-org", ownerType: "user", ownerId: "local-user",
      name: "legacy", eventKeys: ["github.push"], filters: [],
      target: { kind: "assistant", assistant: "user", assistantId: "asst_retired" },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    const res = await patchSubscription(a.baseUrl, "legacy-assistant-rule", { enabled: false });
    expect(res.status).toBe(200);
    const [row] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "legacy-assistant-rule"));
    expect(row.enabled).toBe(false);
    expect(row.target).toEqual({ kind: "assistant", assistant: "user" });
  });

  it("refuses assistantId on a workflow target", async () => {
    const a = await bootTestApi({ plugins: [githubPlugin] });
    const { mine } = await seedAssistants(a);
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "wrong kind",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "workflow", workflowId: "w1", assistantId: mine },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Assistant selection is not supported");
  });
});

/**
 * Prompt templates on an orchestrator target (TKAI-491). The write gate is
 * what makes the delivery-time renderer total, so every refusal it owes is
 * asserted here; the rendering itself is `events/prompt-template.test.ts`.
 */
describe("event-subscription prompt templates", () => {
  const PROMPT_BODY = {
    name: "triage",
    eventKeys: ["github.pull_request.opened"],
    target: {
      kind: "assistant",
      systemPrompt: "Triage this pull request. Answer in one sentence.",
      userPromptTemplate: "{{payload.sender}} opened {{payload.repo}}: {{event.summary}}",
    },
  };

  it("stores both templates on the target and reads them back", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, PROMPT_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.target).toMatchObject({
      kind: "assistant",
      systemPrompt: PROMPT_BODY.target.systemPrompt,
      userPromptTemplate: PROMPT_BODY.target.userPromptTemplate,
    });
  });

  it("400s a template variable outside the documented set, naming the fix", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "assistant", userPromptTemplate: "{{session.history}}" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown variable");
    expect(body.error).toContain("event.summary");
  });

  it("400s a payload field the selected events do not declare", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "assistant", userPromptTemplate: "{{payload.comment_body}}" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.comment_body");
  });

  it("400s a malformed template", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "assistant", systemPrompt: "Watch {{refs.repo" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unclosed");
  });

  it("400s event text in the instruction field, so a sender cannot write the instruction", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "assistant", systemPrompt: "Follow this: {{payload.sender}}" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("{{payload.sender}}");
    expect(body.error).toContain("userPromptTemplate");
  });

  it("stores a template that shows the assistant a JSON shape", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: {
        kind: "assistant",
        systemPrompt: 'Reply with JSON like {"summary": {"text": "x"}}',
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.target).toMatchObject({
      systemPrompt: 'Reply with JSON like {"summary": {"text": "x"}}',
    });
  });

  it("400s a prompt template on a workflow target, so workflow prompts stay the workflow's own", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...PROMPT_BODY,
      target: { kind: "workflow", workflowId: "wf-1", systemPrompt: "Do it" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "systemPrompt is only valid on an assistant target",
    );
  });

  it("patches a template, and null clears it back to the default delivery", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, PROMPT_BODY)).json()) as EventSubscriptionWire;

    const patched = (await (
      await patchSubscription(a.baseUrl, created.id, { systemPrompt: "Summarize it instead." })
    ).json()) as PatchEventSubscriptionResponse;
    expect(patched.target).toMatchObject({
      systemPrompt: "Summarize it instead.",
      userPromptTemplate: PROMPT_BODY.target.userPromptTemplate,
    });

    const cleared = (await (
      await patchSubscription(a.baseUrl, created.id, { systemPrompt: null, userPromptTemplate: null })
    ).json()) as PatchEventSubscriptionResponse;
    expect(cleared.target).toEqual({ kind: "assistant" });
  });

  it("400s a patched template that names a variable the rule's events do not declare", async () => {
    const a = await boot();
    const created = (await (await postSubscription(a.baseUrl, PROMPT_BODY)).json()) as EventSubscriptionWire;
    const res = await patchSubscription(a.baseUrl, created.id, {
      userPromptTemplate: "{{payload.comment_body}}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.comment_body");
  });

  it("re-validates a stored template against narrowed eventKeys", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, {
        name: "pr numbers",
        eventKeys: ["github.pull_request.opened"],
        target: { kind: "assistant", userPromptTemplate: "PR {{payload.pr_number}}" },
      })
    ).json()) as EventSubscriptionWire;

    // `pr_number` is a pull_request field; an issues-only rule cannot render it.
    const res = await patchSubscription(a.baseUrl, created.id, { eventKeys: ["github.issues.opened"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("payload.pr_number");
  });
});

describe("GET /api/events/filter-options", () => {
  // A plugin with two option sources: a plain one and one that dependsOn the
  // first, so the endpoint's dispatch, query passthrough, and dependsOn gating
  // are exercised without hitting a real provider.
  const fixturePlugin: ValetPlugin = {
    name: "fixture",
    version: "0",
    triggers: [
      {
        id: "fixture.thing",
        service: "fixture",
        description: "",
        verify: () => null,
        toEvent: (e) => ({
          key: "fixture.thing",
          dedupeKey: "d",
          occurredAt: new Date(0).toISOString(),
          refs: {},
          summary: "",
          payload: e.payload,
        }),
        catalog: [
          {
            key: "fixture.thing",
            description: "",
            filters: [
              { field: "repo", path: "repo", description: "", options: { source: "fixture.repos" } },
              { field: "branch", path: "branch", description: "", options: { source: "fixture.branches", dependsOn: ["repo"] } },
            ],
          },
        ],
      },
    ],
    filterOptionResolvers: {
      "fixture.repos": async (ctx) =>
        [
          { id: "acme/app", label: "acme/app" },
          { id: "acme/web", label: "acme/web" },
        ].filter((o) => !ctx.q || o.label.includes(ctx.q)),
      "fixture.branches": async (ctx) => (ctx.deps.repo ? [{ id: "main", label: "main" }] : []),
    },
  };

  async function bootFixture(): Promise<TestApi> {
    api = await bootTestApi({ plugins: [fixturePlugin] });
    return api;
  }

  it("lists a source's options and filters by q", async () => {
    const a = await bootFixture();
    const all = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.repos`)).json()) as {
      options: { id: string; label: string }[];
    };
    expect(all.options).toEqual([
      { id: "acme/app", label: "acme/app" },
      { id: "acme/web", label: "acme/web" },
    ]);
    const filtered = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.repos&q=web`)).json()) as {
      options: { id: string }[];
    };
    expect(filtered.options).toEqual([{ id: "acme/web", label: "acme/web" }]);
  });

  it("passes a dependsOn value through; empty without it", async () => {
    const a = await bootFixture();
    const without = (await (await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.branches`)).json()) as {
      options: unknown[];
    };
    expect(without.options).toEqual([]);
    const withRepo = (await (
      await fetch(`${a.baseUrl}/api/events/filter-options?source=fixture.branches&repo=acme/app`)
    ).json()) as { options: { id: string }[] };
    expect(withRepo.options).toEqual([{ id: "main", label: "main" }]);
  });

  it("unknown source returns an empty list and a reason, not an error", async () => {
    const a = await bootFixture();
    const res = await fetch(`${a.baseUrl}/api/events/filter-options?source=nope`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: unknown[]; reason?: string };
    expect(body.options).toEqual([]);
    expect(body.reason).toContain("unknown option source");
  });

  it("400s when source is missing", async () => {
    const a = await bootFixture();
    const res = await fetch(`${a.baseUrl}/api/events/filter-options`);
    expect(res.status).toBe(400);
  });

  // A rate-limited provider used to poison the 60s memo: the empty list from
  // the failed call was cached, so every retry inside the next minute answered
  // "no options" from cache and the user could not recover by retrying.
  it("does not cache a failed lookup, so the next call retries the provider", async () => {
    let calls = 0;
    // Its own source name: `filterOptionsCache` is module state keyed by
    // (org, source, deps, q), and it outlives each test's api instance.
    const flakyPlugin: ValetPlugin = {
      ...fixturePlugin,
      filterOptionResolvers: {
        "fixture.flaky": async () => {
          calls += 1;
          if (calls === 1) throw new Error("ratelimited");
          return [{ id: "acme/app", label: "acme/app" }];
        },
      },
    };
    api = await bootTestApi({ plugins: [flakyPlugin] });

    const first = (await (await fetch(`${api.baseUrl}/api/events/filter-options?source=fixture.flaky`)).json()) as {
      options: unknown[];
      reason?: string;
    };
    expect(first.options).toEqual([]);
    expect(first.reason).toContain("could not list options");

    const second = (await (await fetch(`${api.baseUrl}/api/events/filter-options?source=fixture.flaky`)).json()) as {
      options: { id: string }[];
      reason?: string;
    };
    expect(second.options).toEqual([{ id: "acme/app", label: "acme/app" }]);
    expect(second.reason).toBeUndefined();
    expect(calls).toBe(2);
  });
});

// ── Mention scoping (TKAI-299) ─────────────────────────────────────────────
//
// A subscription selecting `slack.app_mention` must name channels (or set the
// explicit `anyChannel` flag) and is force-filtered to its creator's linked
// Slack user. See `events/mention-scope.ts`.

describe("mention scoping (slack.app_mention)", () => {
  async function bootSlack(): Promise<TestApi> {
    api = await bootTestApi({ plugins: [slackPlugin] });
    return api;
  }

  /** Links a Valet user to a Slack user id, as the connect flow would. */
  async function linkSlack(a: TestApi, userId: string, externalId: string): Promise<void> {
    await a.providers.db.insert(userIdentityLinks).values({
      id: `uil-${userId}`,
      provider: "slack",
      externalId,
      userId,
      createdAt: Date.now(),
      notifyAttention: true,
    });
  }

  const MENTION_BODY: CreateEventSubscriptionRequest = {
    name: "my mentions",
    eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel", op: "eq", value: "C123", label: "#eng" }],
    target: { kind: "assistant" },
  };

  it("a team-owned mention subscription uses membership instead of a creator filter", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "assistant", assistant: "team", teamId: "team_1" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe("team_1");
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123", label: "#eng" },
    ]);
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual(body.filters);
  });

  it("a team mention rule takes an organization audience, and an absent one reads back as team", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const teamTarget: EventSubscriptionTargetWire = { kind: "assistant", assistant: "team", teamId: "team_1" };

    const open = await postSubscription(a.baseUrl, { ...MENTION_BODY, target: teamTarget, audience: "organization" });
    expect(open.status).toBe(201);
    const opened = (await open.json()) as CreateEventSubscriptionResponse;
    expect(opened.audience).toBe("organization");
    const openRows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, opened.id));
    expect(openRows[0].audience).toBe("organization");

    const quiet = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      name: "team only",
      filters: [{ field: "channel", op: "eq", value: "C999" }],
      target: teamTarget,
    });
    expect(quiet.status).toBe(201);
    const quieted = (await quiet.json()) as CreateEventSubscriptionResponse;
    expect(quieted.audience).toBe("team");
    const quietRows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, quieted.id));
    expect(quietRows[0].audience).toBeNull();
  });

  it("patches the audience of a team mention rule in both directions", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "assistant", assistant: "team", teamId: "team_1" },
    });
    const created = (await res.json()) as CreateEventSubscriptionResponse;

    const opened = await patchSubscription(a.baseUrl, created.id, { audience: "organization" });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as PatchEventSubscriptionResponse).audience).toBe("organization");

    const closed = await patchSubscription(a.baseUrl, created.id, { audience: "team" });
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as PatchEventSubscriptionResponse).audience).toBe("team");
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].audience).toBe("team");
  });

  // A client that GETs a rule and PATCHes the object back must not be refused
  // for echoing a field the read itself filled in.
  it("accepts a read-modify-write patch of a rule that has no audience", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const created = (await (await postSubscription(a.baseUrl, {
      name: "my mentions", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }],
      target: { kind: "assistant", assistant: "user" },
    })).json()) as CreateEventSubscriptionResponse;

    const list = (await (await fetch(`${a.baseUrl}/api/event-subscriptions`)).json()) as ListEventSubscriptionsResponse;
    const echoed = list.subscriptions.find((sub) => sub.id === created.id);
    expect(echoed).toBeDefined();
    // A personal target carries no audience on the wire at all.
    expect(echoed?.audience).toBeUndefined();

    const res = await patchSubscription(a.baseUrl, created.id, { ...echoed, name: "renamed" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchEventSubscriptionResponse).name).toBe("renamed");
  });

  // The runtime gate treats team ownership plus an orchestrator target as a
  // team mention rule, with no `assistant: "team"` on the target. The write
  // gate must read the same rows the same way.
  it("patches the audience of a team-owned rule whose target names no orchestrator", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    await seedSubscriptionRow(a, "sub_runtime", "local-org", {
      ownerType: "team", ownerId: "team_1", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }],
      target: { kind: "assistant" },
    });

    const res = await patchSubscription(a.baseUrl, "sub_runtime", { audience: "organization" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchEventSubscriptionResponse).audience).toBe("organization");
  });

  it("names the two accepted values when the audience is malformed", async () => {
    const a = await bootSlack();
    const now = Date.now();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: now });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "local-user", role: "admin" });
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      target: { kind: "assistant", assistant: "team", teamId: "team_1" },
      audience: "everyone",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'audience must be "team" or "organization". Choose one of those two values, or remove the audience.',
    );
  });

  it.each<EventSubscriptionTargetWire>([
    { kind: "workflow", workflowId: "wf_1" },
    { kind: "assistant", assistant: "user" },
  ])("refuses an audience on a target that is not a team assistant (%o)", async (target) => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, target, audience: "organization" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Only a mention line for a team assistant has an invocation audience. Point the line at a team assistant, or remove the audience.",
    );
  });

  it.each(["team", "organization"])("redelivery rechecks the mentioner's current %s membership", async (removed) => {
    const a = await bootSlack();
    await a.providers.eventDispatcher.stop();
    await a.providers.db.insert(teams).values({ id: "team-replay", orgId: "local-org", name: "Replay", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "team-replay", userId: "member-b", role: "member" });
    await a.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "member-b", role: "member" });
    await linkSlack(a, "member-b", "U_B");
    await seedSubscriptionRow(a, "sub-replay", "local-org", {
      ownerType: "team", ownerId: "team-replay", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }], target: { kind: "assistant" },
    });
    // An event from a channel nobody has classified stays hidden (`routes/events.ts#eventVisibleTo`).
    await a.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "C1", isPrivate: false, checkedAt: Date.now() });
    await a.providers.db.insert(events).values({
      id: "event-replay", orgId: "local-org", service: "slack", eventKey: "slack.app_mention",
      dedupeKey: "replay", actor: { externalId: "U_B" }, refs: {}, summary: "Mention",
      payload: { user: "U_B", channel: "C1", ts: "1.2" }, occurredAt: Date.now(), receivedAt: Date.now(),
    });
    const first = await redeliver(a.baseUrl, "event-replay");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ created: 1 });
    if (removed === "team") {
      await a.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "team-replay"));
    } else {
      await a.providers.db.delete(orgMembers).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "member-b")));
      // A stale team row and membership elsewhere must not authorize replay.
      await a.providers.db.insert(orgMembers).values({ orgId: "other-org", userId: "member-b", role: "member" });
      expect(await a.providers.db.select().from(teamMembers).where(eq(teamMembers.teamId, "team-replay"))).toHaveLength(1);
    }
    const second = await redeliver(a.baseUrl, "event-replay");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: 0 });
  });

  it("injects the creator's linked Slack user filter on create", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, MENTION_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123", label: "#eng" },
      { field: "user", op: "eq", value: "U_LOCAL" },
    ]);
    const rows = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, body.id));
    expect(rows[0].filters).toEqual(body.filters);
  });

  it("keeps a user filter that already names the creator, without duplicating it", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [...MENTION_BODY.filters!, { field: "user", op: "eq", value: "U_LOCAL" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters!.filter((f) => f.field === "user")).toHaveLength(1);
  });

  it("refuses a user filter naming someone else", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [...MENTION_BODY.filters!, { field: "user", op: "eq", value: "U_OTHER" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("own @-mentions");
  });

  it("refuses creation when the creator has no linked Slack account", async () => {
    const a = await bootSlack();
    const res = await postSubscription(a.baseUrl, MENTION_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Integrations → Slack");
  });

  it("refuses creation without a channel filter unless anyChannel is set", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, filters: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^A mention line needs at least one channel filter/);
  });

  it("a prefix channel filter does not satisfy the channel requirement", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "prefix", value: "C" }],
    });
    expect(res.status).toBe(400);
  });

  it("accepts multiple channels via an in filter", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "in", value: ["C123", "C456"] }],
    });
    expect(res.status).toBe(201);
  });

  it("anyChannel: true permits a channel-less mention subscription", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, filters: [], anyChannel: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([{ field: "user", op: "eq", value: "U_LOCAL" }]);
  });

  it("refuses anyChannel combined with channel filters", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, anyChannel: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Any channel");
  });

  it("refuses mixing app_mention with any other key", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const noUserField = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      eventKeys: ["slack.app_mention", "slack.channel_archive"],
    });
    expect(noUserField.status).toBe(400);
    expect(((await noUserField.json()) as { error: string }).error).toContain("slack.channel_archive");

    // A key WITH a user field is refused too: the injected creator filter
    // would silently narrow it to the creator's own events.
    const withUserField = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      eventKeys: ["slack.app_mention", "slack.message"],
    });
    expect(withUserField.status).toBe(400);
    expect(((await withUserField.json()) as { error: string }).error).toContain("slack.message");
  });

  it("refuses an empty channel in list instead of storing a dead filter", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, {
      ...MENTION_BODY,
      filters: [{ field: "channel", op: "in", value: [] }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("empty list");
  });

  it("a slack.* wildcard cannot widen around the gate", async () => {
    const a = await bootSlack();
    await linkSlack(a, "local-user", "U_LOCAL");
    const res = await postSubscription(a.baseUrl, { ...MENTION_BODY, eventKeys: ["slack.*"] });
    // The wildcard selects app_mention, so scoping applies — and the wildcard
    // also selects user-less keys, which the mix rule refuses.
    expect(res.status).toBe(400);
  });

  it("leaves non-mention slack subscriptions unscoped", async () => {
    const a = await bootSlack();
    const res = await postSubscription(a.baseUrl, {
      name: "all channel messages",
      eventKeys: ["slack.message"],
      filters: [],
      target: { kind: "assistant" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([]);
  });

  it("PATCH re-applies scoping keyed to the creator when filters change", async () => {
    const a = await bootSlack();
    // Row created by `someone` (linked), owned by the caller so it is mutable.
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m1", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [
        { field: "channel", op: "eq", value: "C123" },
        { field: "user", op: "eq", value: "U_SOMEONE" },
      ],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [], anyChannel: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    // The injected filter names the CREATOR's Slack user, not the caller's.
    expect(body.filters).toEqual([{ field: "user", op: "eq", value: "U_SOMEONE" }]);
  });

  it("PATCH of a stored any-channel row keeps working without re-sending the flag", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    // Stored any-channel state: mention key, no channel filter.
    await seedSubscriptionRow(a, "sub_m4", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    // The patch tunes a text filter and never touches channel scope. The
    // server derives the row's any-channel state, so no flag is needed.
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m4`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: [
          { field: "user", op: "eq", value: "U_SOMEONE" },
          { field: "text", op: "contains", value: "deploy" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    expect(body.filters.some((f) => f.field === "text")).toBe(true);
  });

  it("PATCH can narrow a stored any-channel row to named channels", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m5", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: [
          { field: "user", op: "eq", value: "U_SOMEONE" },
          { field: "channel", op: "eq", value: "C999" },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH cannot strip the channel scope without anyChannel", async () => {
    const a = await bootSlack();
    await linkSlack(a, "someone", "U_SOMEONE");
    await seedSubscriptionRow(a, "sub_m2", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [
        { field: "channel", op: "eq", value: "C123" },
        { field: "user", op: "eq", value: "U_SOMEONE" },
      ],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m2`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [{ field: "user", op: "eq", value: "U_SOMEONE" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("an enabled-only PATCH skips scoping, even when the creator is unlinked", async () => {
    const a = await bootSlack();
    // No link for `someone`: a toggle must still work on an old row.
    await seedSubscriptionRow(a, "sub_m3", "local-org", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C123" }],
      ownerType: "user",
      ownerId: "local-user",
    });
    const res = await fetch(`${a.baseUrl}/api/event-subscriptions/sub_m3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe("subscription collision gate (TKAI-294)", () => {
  /** The existing narrow rule the candidates below step on: same event key
   * as VALID_BODY, scoped to one repo. */
  async function seedNarrowRule(a: TestApi, over: SeedSubscriptionOpts = {}): Promise<void> {
    await seedSubscriptionRow(a, "sub_narrow", "local-org", {
      name: "narrow repo rule",
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
      ...over,
    });
  }

  it("409s a create that covers an existing rule, naming it in the payload", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as EventSubscriptionCollisionErrorWire;
    expect(body.error).toContain("narrow repo rule");
    expect(body.collisions.blocking).toHaveLength(1);
    expect(body.collisions.blocking[0].subscription.id).toBe("sub_narrow");
    expect(body.collisions.blocking[0].relation).toBe("superset");
    expect(body.collisions.blocking[0].sharedKeys).toEqual(["github.pull_request.opened"]);

    // The blocked write left no row behind.
    const rows = await a.providers.db.select().from(eventSubscriptions);
    expect(rows).toHaveLength(1);
  });

  it("allowCollision commits the blocked write and reports what it stepped on", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [],
      allowCollision: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions?.blocking.map((b) => b.subscription.id)).toEqual(["sub_narrow"]);
  });

  it("201s an overlapping (non-containing) create with a warning payload", async () => {
    const a = await boot();
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "in", value: ["acme/widgets", "acme/gadgets"] }],
    });

    // VALID_BODY's repo eq is a strict subset of the seeded `in` list.
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions?.blocking).toEqual([]);
    expect(body.collisions?.overlapping.map((o) => o.subscription.id)).toEqual(["sub_narrow"]);
    expect(body.collisions?.overlapping[0].relation).toBe("subset");
  });

  it("ignores disabled rules — an unarmed rule cannot collide", async () => {
    const a = await boot();
    await seedNarrowRule(a, { enabled: false });

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions).toBeUndefined();
  });

  it("ignores disjoint rules — a different repo is no collision", async () => {
    const a = await boot();
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "eq", value: "beta/things" }],
    });

    // VALID_BODY is scoped to acme/widgets; the seeded rule to beta/things.
    const res = await postSubscription(a.baseUrl, VALID_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.collisions).toBeUndefined();
  });

  it("never compares against another org's rules (no cross-org leak)", async () => {
    const a = await boot();
    await seedNarrowRule(a, {});
    // Same coverage, other org — must not appear in any payload.
    await seedSubscriptionRow(a, "sub_foreign", "other-org", {
      eventKeys: ["github.pull_request.opened"],
      filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
    });

    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as EventSubscriptionCollisionErrorWire;
    const ids = [
      ...body.collisions.blocking.map((b) => b.subscription.id),
      ...body.collisions.overlapping.map((o) => o.subscription.id),
    ];
    expect(ids).toEqual(["sub_narrow"]);
  });

  it("409s a PATCH that widens a rule over an existing one; allowCollision overrides", async () => {
    const a = await boot();
    const created = (await (
      await postSubscription(a.baseUrl, VALID_BODY)
    ).json()) as CreateEventSubscriptionResponse;
    await seedNarrowRule(a, {
      filters: [{ field: "repo", op: "eq", value: "acme/gadgets" }],
    });

    const patch = (extra: Record<string, unknown>) =>
      fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: [], ...extra }),
      });

    const blocked = await patch({});
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as EventSubscriptionCollisionErrorWire;
    expect(blockedBody.collisions.blocking[0].subscription.id).toBe("sub_narrow");
    // The refused patch changed nothing.
    const rows = await a.providers.db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, created.id));
    expect(rows[0].filters).toEqual(VALID_BODY.filters);

    const overridden = await patch({ allowCollision: true });
    expect(overridden.status).toBe(200);
    const body = (await overridden.json()) as PatchEventSubscriptionResponse;
    expect(body.collisions?.blocking.map((b) => b.subscription.id)).toEqual(["sub_narrow"]);
  });

  it("a disabled create skips the gate; enabling it later runs it", async () => {
    const a = await boot();
    await seedNarrowRule(a);

    const created = (await (
      await postSubscription(a.baseUrl, { ...VALID_BODY, filters: [], enabled: false })
    ).json()) as CreateEventSubscriptionResponse;
    expect(created.collisions).toBeUndefined();

    const arm = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(arm.status).toBe(409);

    // A patch that leaves the rule disabled stays uncheckable — nothing fires.
    const rename = await fetch(`${a.baseUrl}/api/event-subscriptions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "still parked" }),
    });
    expect(rename.status).toBe(200);
  });
});

describe("replacement proposals", () => {
  const MATCH = {
    eventKeys: ["github.pull_request.opened"],
    filters: [{ field: "repo", op: "eq" as const, value: "acme/widgets" }],
  };

  /** The caller's live rule and a disabled proposal that replaces it, with
   * the same match, so they would collide if both were enabled. */
  async function seedReplacement(a: TestApi): Promise<void> {
    const mine = { ownerType: "user" as const, ownerId: "local-user", ...MATCH };
    await seedSubscriptionRow(a, "sub_live", "local-org", { ...mine, name: "replies v1" });
    await seedSubscriptionRow(a, "sub_next", "local-org", {
      ...mine, name: "replies v2", enabled: false, target: { kind: "assistant", replaces: "sub_live" },
    });
  }

  async function enabledById(a: TestApi): Promise<Record<string, boolean>> {
    const rows = await a.providers.db.select().from(eventSubscriptions);
    return Object.fromEntries(rows.map((r) => [r.id, r.enabled]));
  }

  it("enabling a replacement disables the replaced subscription, never one in another workspace", async () => {
    const a = await boot();
    await seedReplacement(a);
    // A hand-written link to a colleague's rule is refused: from this
    // workspace the rule does not exist, and the colleague's rule stays on.
    await seedSubscriptionRow(a, "sub_colleague", "local-org", {
      ...MATCH, filters: [{ field: "repo", op: "eq", value: "acme/colleague" }],
    });
    await seedSubscriptionRow(a, "sub_stray", "local-org", {
      ownerType: "user", ownerId: "local-user", enabled: false, eventKeys: MATCH.eventKeys,
      filters: [{ field: "repo", op: "eq", value: "acme/stray" }], target: { kind: "assistant", replaces: "sub_colleague" },
    });
    expect((await patchSubscription(a.baseUrl, "sub_stray", { enabled: true })).status).toBe(409);
    expect(await enabledById(a)).toMatchObject({ sub_colleague: true, sub_stray: false });
    // A link to a workflow trigger is refused too: a trigger is not an assistant version.
    await seedSubscriptionRow(a, "sub_trigger", "local-org", {
      ownerType: "user", ownerId: "local-user", eventKeys: MATCH.eventKeys,
      filters: [{ field: "repo", op: "eq", value: "acme/trigger" }], target: { kind: "workflow", workflowId: "wf-1" },
    });
    await seedSubscriptionRow(a, "sub_takeover", "local-org", {
      ownerType: "user", ownerId: "local-user", enabled: false, eventKeys: MATCH.eventKeys,
      filters: [{ field: "repo", op: "eq", value: "acme/takeover" }], target: { kind: "assistant", replaces: "sub_trigger" },
    });
    expect((await patchSubscription(a.baseUrl, "sub_takeover", { enabled: true })).status).toBe(409);
    expect(await enabledById(a)).toMatchObject({ sub_trigger: true, sub_takeover: false });

    // The replaced rule is not a collision peer, so no override is needed.
    const res = await patchSubscription(a.baseUrl, "sub_next", { enabled: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchEventSubscriptionResponse;
    expect(body.enabled).toBe(true);
    expect(body.collisions).toBeUndefined();
    expect(await enabledById(a)).toMatchObject({ sub_live: false, sub_next: true });
    // The link is spent and recorded: turning the new version off and on leaves the old one alone.
    expect(body.target).not.toHaveProperty("replaces");
    expect(body.target).toMatchObject({ replaced: "sub_live" });
    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: false })).status).toBe(200);
    expect((await patchSubscription(a.baseUrl, "sub_live", { enabled: true })).status).toBe(200);
    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: true, allowCollision: true })).status).toBe(200);
    expect(await enabledById(a)).toMatchObject({ sub_live: true, sub_next: true });
  });

  // Whatever turned the replaced version off, the 409 sends the reviewer to
  // the version that replies now and never says to turn the old one back on:
  // its history decides whether that leaves two versions replying.
  async function expectStale(a: TestApi, id: string): Promise<void> {
    const stale = await patchSubscription(a.baseUrl, id, { enabled: true, allowCollision: true });
    expect(stale.status).toBe(409);
    const message = ((await stale.json()) as { error: string }).error;
    expect(message).toContain("Delete this proposal.");
    expect(message).not.toContain("back on");
  }

  it("refuses a replacement whose version a sibling already replaced", async () => {
    const a = await boot();
    await seedReplacement(a);
    await seedSubscriptionRow(a, "sub_sibling", "local-org", {
      ownerType: "user", ownerId: "local-user", ...MATCH, name: "replies v3", enabled: false, target: { kind: "assistant", replaces: "sub_live" },
    });
    expect((await patchSubscription(a.baseUrl, "sub_sibling", { enabled: true })).status).toBe(200);
    await expectStale(a, "sub_next");
    expect(await enabledById(a)).toMatchObject({ sub_live: false, sub_next: false, sub_sibling: true });
  });

  it("refuses a replacement of a version that was rolled back, and of one rolled back and then paused", async () => {
    const a = await boot();
    await seedReplacement(a);
    const mine = { ownerType: "user" as const, ownerId: "local-user", ...MATCH, enabled: false };
    await seedSubscriptionRow(a, "sub_v3", "local-org", { ...mine, name: "replies v3", target: { kind: "assistant", replaces: "sub_next" } });
    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: true })).status).toBe(200);
    // Roll back by hand: the new version off, the original on.
    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: false })).status).toBe(200);
    expect((await patchSubscription(a.baseUrl, "sub_live", { enabled: true, allowCollision: true })).status).toBe(200);
    await expectStale(a, "sub_v3");
    expect(await enabledById(a)).toMatchObject({ sub_live: true, sub_next: false, sub_v3: false });
    // A proposal for the restored original works while it is on; once it is paused, it is stale too.
    await seedSubscriptionRow(a, "sub_q", "local-org", { ...mine, name: "replies q", target: { kind: "assistant", replaces: "sub_live" } });
    expect((await patchSubscription(a.baseUrl, "sub_live", { enabled: false })).status).toBe(200);
    await expectStale(a, "sub_q");
  });

  it("refuses a stale replacement after the version that replaced it is deleted, and writes nothing onto the replaced row", async () => {
    const a = await boot();
    await seedReplacement(a);
    const [before] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_live"));
    const mine = { ownerType: "user" as const, ownerId: "local-user", ...MATCH, enabled: false };
    await seedSubscriptionRow(a, "sub_old", "local-org", { ...mine, name: "replies v2b", target: { kind: "assistant", replaces: "sub_live" } });
    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: true })).status).toBe(200);
    // The replaced row keeps its own target, so a retried proposal for it still matches.
    const [after] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_live"));
    expect(after.target).toEqual(before.target);
    await a.providers.db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_next"));
    await expectStale(a, "sub_old");
  });

  it("refuses a replacement whose version was removed, and keeps its link", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_orphan", "local-org", {
      ownerType: "user", ownerId: "local-user", ...MATCH, name: "replies v2", enabled: false, target: { kind: "assistant", replaces: "sub_gone" },
    });
    const refused = await patchSubscription(a.baseUrl, "sub_orphan", { enabled: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Delete this proposal") });
    const [orphan] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "sub_orphan"));
    expect(orphan).toMatchObject({ enabled: false, target: { replaces: "sub_gone" } });
  });

  it("stores no replacement link on a direct create", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { ...VALID_BODY.target, replaces: "sub_live" } });
    expect(created.status).toBe(201);
    expect((await created.json() as CreateEventSubscriptionResponse).target).not.toHaveProperty("replaces");
  });

  it("rolls back the enable when the replaced subscription cannot be disabled", async () => {
    const a = await boot();
    await seedReplacement(a);
    // Fail only the second write of the transaction: the disable of sub_live.
    await a.providers.db.execute(sql`
      CREATE FUNCTION refuse_live_disable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$`);
    await a.providers.db.execute(sql`
      CREATE TRIGGER refuse_live_disable BEFORE UPDATE ON event_subscriptions
      FOR EACH ROW WHEN (OLD.id = 'sub_live') EXECUTE FUNCTION refuse_live_disable()`);

    expect((await patchSubscription(a.baseUrl, "sub_next", { enabled: true })).status).toBe(500);
    expect(await enabledById(a)).toMatchObject({ sub_live: true, sub_next: false });
  });
});

describe("event-subscription thread policy (spec 2026-10-16, Part A)", () => {
  const CROSS_OWNER = "This thread belongs to another owner. Pick a thread in your workspace.";
  const ARCHIVED = "This thread is archived. Pick an open thread.";

  function withThread(thread: unknown): unknown {
    return { ...VALID_BODY, target: { kind: "assistant", thread } };
  }

  it("refuses an existing thread of another owner", async () => {
    const a = await boot();
    const foreign = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "someone-else" }, sessionId: "sess-foreign", threadId: "thr-foreign",
    });
    const res = await postSubscription(a.baseUrl, withThread({ mode: "existing", ...foreign }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CROSS_OWNER });
    expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);
  });

  it("refuses a thread id that does not exist like another owner's", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, withThread({ mode: "existing", sessionId: "sess-none", threadId: "thr-none" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CROSS_OWNER });
  });

  it("refuses an archived thread of the owner", async () => {
    const a = await boot();
    const mine = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "local-user" }, sessionId: "sess-mine", threadId: "thr-old", archived: true,
    });
    const res = await postSubscription(a.baseUrl, withThread({ mode: "existing", ...mine }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ARCHIVED });
  });

  it("stores an open thread of the owner and reads it back", async () => {
    const a = await boot();
    const mine = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "local-user" }, sessionId: "sess-mine", threadId: "thr-ci",
    });
    const res = await postSubscription(a.baseUrl, withThread({ mode: "existing", ...mine }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateEventSubscriptionResponse;
    expect(created.target).toEqual({ kind: "assistant", thread: { mode: "existing", ...mine } });
    const [row] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(row.target).toEqual({ kind: "assistant", thread: { mode: "existing", ...mine } });
  });

  it("refuses an owner's thread outside an assistant conversation", async () => {
    const a = await boot();
    const plain = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "local-user" }, sessionId: "sess-plain", threadId: "thr-plain", assistant: false,
    });
    const res = await postSubscription(a.baseUrl, withThread({ mode: "existing", ...plain }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This thread is not in a live assistant conversation. Pick a thread in your assistant." });
    expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);
  });

  it("checks a team rule's pin against the team, not the caller", async () => {
    const a = await boot();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });
    const teamThread = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "team", id: "team_1" }, sessionId: "sess-team", threadId: "thr-team",
    });
    const personal = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "test-member" }, sessionId: "sess-personal", threadId: "thr-personal",
    });
    const teamTarget = (thread: unknown) => ({ ...VALID_BODY, target: { kind: "assistant", assistant: "team", teamId: "team_1", thread } });
    const asMember = { "x-valet-test-user-id": "test-member" };

    const refused = await postSubscription(a.baseUrl, teamTarget({ mode: "existing", ...personal }), asMember);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: CROSS_OWNER });
    expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);

    const accepted = await postSubscription(a.baseUrl, teamTarget({ mode: "existing", ...teamThread }), asMember);
    expect(accepted.status).toBe(201);
    const created = (await accepted.json()) as CreateEventSubscriptionResponse;
    expect(created.ownerType).toBe("team");
    const [row] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(row.target).toMatchObject({ thread: { mode: "existing", ...teamThread } });
  });

  /** Answers Slack's membership check: `members` lists each private channel's members. */
  async function connectSlack(a: TestApi, members: Record<string, string[]>) {
    await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
    const realFetch = globalThis.fetch;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "slack.com") return realFetch(input, init);
      const channel = url.searchParams.get("channel") ?? "";
      const body = url.pathname.endsWith("conversations.members")
        ? { ok: true, members: members[channel] ?? [] }
        : { ok: true, channel: { name: channel.toLowerCase(), is_private: members[channel] !== undefined } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
  }

  it("lets a team rule pin a private-channel thread only for the channel's members", async () => {
    const a = await boot();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values([
      { teamId: "team_1", userId: "local-user", role: "member" },
      { teamId: "team_1", userId: "test-member", role: "member" },
    ]);
    await a.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CPINPRIV", isPrivate: true, checkedAt: Date.now() });
    await a.providers.db.insert(userIdentityLinks).values({ id: "uil-local-user", provider: "slack", externalId: "U_LOCAL", userId: "local-user", createdAt: Date.now() });
    const slack = await connectSlack(a, { CPINPRIV: ["U_LOCAL"] });
    const privateThread = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "team", id: "team_1" }, sessionId: "sess-team", threadId: "thr-incident",
      key: "sub:incident", slackChannels: ["CPINPRIV"],
    });
    const teamTarget = (thread: unknown) => ({ ...VALID_BODY, target: { kind: "assistant", assistant: "team", teamId: "team_1", thread } });
    const asOutsider = { "x-valet-test-user-id": "test-member" };
    try {
      // A team member outside the private channel gets the cross-owner text.
      const refused = await postSubscription(a.baseUrl, teamTarget({ mode: "existing", ...privateThread }), asOutsider);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: CROSS_OWNER });
      expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);

      // A channel member may pin it.
      const accepted = await postSubscription(a.baseUrl, teamTarget({ mode: "existing", ...privateThread }));
      expect(accepted.status).toBe(201);
      const created = (await accepted.json()) as CreateEventSubscriptionResponse;

      // A patch is checked against the person who sends it, not the rule's creator.
      const repinned = await patchSubscription(a.baseUrl, created.id, { thread: { mode: "existing", ...privateThread } }, asOutsider);
      expect(repinned.status).toBe(400);
      expect(await repinned.json()).toEqual({ error: CROSS_OWNER });
    } finally {
      slack.mockRestore();
    }
  });

  it("refuses pinning a shared thread to a rule that names a private channel the thread does not hold", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values([
      { teamId: "team_1", userId: "local-user", role: "member" },
      { teamId: "team_1", userId: "test-member", role: "member" },
    ]);
    await a.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CPINPRIV", isPrivate: true, checkedAt: Date.now() });
    await a.providers.db.insert(userIdentityLinks).values({ id: "uil-local-user", provider: "slack", externalId: "U_LOCAL", userId: "local-user", createdAt: Date.now() });
    const slack = await connectSlack(a, { CPINPRIV: ["U_LOCAL"] });
    const shared = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "team", id: "team_1" }, sessionId: "sess-team", threadId: "thr-shared", key: "sub:standup",
    });
    // A second thread in the same assistant that already holds the channel's content.
    await a.providers.db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, metadata, created_at, updated_at)
      VALUES ('thr-holding', 'sess-team', 'sub:incidents', 'idle', 'steer', ${JSON.stringify({ slackChannels: ["CPINPRIV"] })}, 1, 1)`);
    const rule = (thread: unknown) => ({
      name: "incident mentions", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "CPINPRIV", label: "#incidents" }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team_1", thread },
    });
    try {
      const refused = await postSubscription(a.baseUrl, rule({ mode: "existing", ...shared }));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "This thread is shared with people who cannot see #incidents. Pick a thread only you can see, or let this line use its own thread.",
      });
      expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);

      // A thread that already holds the channel's content keeps its audience.
      const accepted = await postSubscription(a.baseUrl, rule({ mode: "existing", sessionId: "sess-team", threadId: "thr-holding" }));
      expect(accepted.status, await accepted.clone().text()).toBe(201);

      // A filter edit that names the private channel on a pinned shared thread is refused too.
      const own = await postSubscription(a.baseUrl, { ...rule({ mode: "existing", ...shared }), filters: [{ field: "channel", op: "eq", value: "CPUBLIC", label: "#general" }] });
      expect(own.status, await own.clone().text()).toBe(201);
      const pinned = (await own.json()) as CreateEventSubscriptionResponse;
      const narrowed = await patchSubscription(a.baseUrl, pinned.id, { filters: [{ field: "channel", op: "in", value: ["CPUBLIC", "CPINPRIV"] }] });
      expect(narrowed.status).toBe(400);
      expect(await narrowed.json()).toEqual({
        error: "This thread is shared with people who cannot see #CPINPRIV. Pick a thread only you can see, or let this line use its own thread.",
      });
    } finally {
      slack.mockRestore();
    }
  });

  it("lets a personal rule pin its own thread to a private channel", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    await a.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CPINPRIV", isPrivate: true, checkedAt: Date.now() });
    await a.providers.db.insert(userIdentityLinks).values({ id: "uil-local-user", provider: "slack", externalId: "U_LOCAL", userId: "local-user", createdAt: Date.now() });
    const slack = await connectSlack(a, { CPINPRIV: ["U_LOCAL"] });
    const mine = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "local-user" }, sessionId: "sess-mine", threadId: "thr-mine", key: "sub:standup",
    });
    try {
      const res = await postSubscription(a.baseUrl, {
        name: "incident mentions", eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "CPINPRIV", label: "#incidents" }],
        target: { kind: "orchestrator", thread: { mode: "existing", ...mine } },
      });
      expect(res.status, await res.clone().text()).toBe(201);
    } finally {
      slack.mockRestore();
    }
  });

  it("refuses a team rule's pin on a member's personal thread, even for that member", async () => {
    const a = await boot();
    await a.providers.db.insert(teams).values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "team_1", userId: "test-member", role: "member" });
    const helper = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "team", id: "team_1" }, sessionId: "sess-team", threadId: "thr-helper",
      key: "app-assistant:test-member",
    });
    const body = { ...VALID_BODY, target: { kind: "assistant", assistant: "team", teamId: "team_1", thread: { mode: "existing", ...helper } } };
    const res = await postSubscription(a.baseUrl, body, { "x-valet-test-user-id": "test-member" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CROSS_OWNER });
    expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);
  });

  it("patches the policy, refuses another owner's thread, and clears it with null", async () => {
    const a = await boot();
    const foreign = await seedAssistantThread(a.providers.db, {
      orgId: "local-org", owner: { type: "user", id: "someone-else" }, sessionId: "sess-foreign", threadId: "thr-foreign",
    });
    const created = (await (await postSubscription(a.baseUrl, withThread({ mode: "new" }))).json()) as CreateEventSubscriptionResponse;
    expect(created.target).toEqual({ kind: "assistant", thread: { mode: "new" } });

    const refused = await patchSubscription(a.baseUrl, created.id, { thread: { mode: "existing", ...foreign } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: CROSS_OWNER });

    const subject = await patchSubscription(a.baseUrl, created.id, { thread: { mode: "subject" } });
    expect(subject.status).toBe(200);
    expect(((await subject.json()) as PatchEventSubscriptionResponse).target).toEqual({ kind: "assistant", thread: { mode: "subject" } });

    const cleared = await patchSubscription(a.baseUrl, created.id, { thread: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as PatchEventSubscriptionResponse).target).toEqual({ kind: "assistant" });
    const [row] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, created.id));
    expect(row.target).toEqual({ kind: "assistant" });
  });

  it("refuses a thread patch on a workflow rule", async () => {
    const a = await boot();
    await seedSubscriptionRow(a, "sub_wf", "local-org", {
      ownerId: "local-user", target: { kind: "workflow", workflowId: "wf-1" },
    });
    const res = await patchSubscription(a.baseUrl, "sub_wf", { thread: { mode: "new" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A thread choice applies only when the assistant does the work. Remove the thread from this workflow line." });
  });
});

// Spec 2026-10-16 presence hub, Part H: `presence` became `appearance`, and
// the assistant target's `orchestrator` names became `assistant`. The API
// accepts both on write for one release and emits only the new names.
describe("Part H renames on /api/event-subscriptions", () => {
  async function storedTarget(a: TestApi, id: string): Promise<unknown> {
    const [row] = await a.providers.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, id));
    return row!.target;
  }

  it("accepts the old presence field on create, stores and emits appearance", async () => {
    const a = await boot();
    const appearance = { displayName: "Issue helper" };
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "orchestrator", presence: appearance } });
    expect(res.status).toBe(201);
    const body = await res.json() as CreateEventSubscriptionResponse;
    expect(body.target).toEqual({ kind: "assistant", appearance });
    expect(await storedTarget(a, body.id)).toEqual({ kind: "assistant", appearance });
  });

  it("accepts the new names on create", async () => {
    const a = await boot();
    const appearance = { displayName: "Issue helper" };
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "assistant", assistant: "user", appearance } });
    expect(res.status).toBe(201);
    const body = await res.json() as CreateEventSubscriptionResponse;
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", appearance });
    expect(await storedTarget(a, body.id)).toEqual({ kind: "assistant", assistant: "user", appearance });
  });

  it("accepts the old orchestrator scope field on create and emits assistant", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "orchestrator", orchestrator: "org" } });
    expect(res.status).toBe(201);
    const body = await res.json() as CreateEventSubscriptionResponse;
    expect(body.ownerType).toBe("org");
    expect(body.target).toEqual({ kind: "assistant", assistant: "org" });
    expect(await storedTarget(a, body.id)).toEqual({ kind: "assistant", assistant: "org" });
  });

  it("refuses a create that sends both presence and appearance", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "assistant", presence: { displayName: "Old" }, appearance: { displayName: "New" } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Send appearance, not presence." });
    expect(await a.providers.db.select().from(eventSubscriptions)).toEqual([]);
  });

  it("refuses a create that sends both orchestrator and assistant", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, target: { kind: "assistant", orchestrator: "user", assistant: "user" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Send assistant, not orchestrator." });
  });

  it("accepts the old presence field on patch and refuses both names", async () => {
    const a = await boot();
    const created = await (await postSubscription(a.baseUrl, VALID_BODY)).json() as CreateEventSubscriptionResponse;
    const old = await patchSubscription(a.baseUrl, created.id, { presence: { displayName: "Old name" } });
    expect(old.status).toBe(200);
    expect((await old.json() as PatchEventSubscriptionResponse).target).toEqual({ kind: "assistant", appearance: { displayName: "Old name" } });
    expect(await storedTarget(a, created.id)).toEqual({ kind: "assistant", appearance: { displayName: "Old name" } });
    const both = await patchSubscription(a.baseUrl, created.id, { presence: { displayName: "A" }, appearance: { displayName: "B" } });
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({ error: "Send appearance, not presence." });
    const cleared = await patchSubscription(a.baseUrl, created.id, { presence: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as PatchEventSubscriptionResponse).target).toEqual({ kind: "assistant" });
  });

  it("reads a stored row with the old names as the new names", async () => {
    const a = await boot();
    const now = Date.now();
    await a.providers.db.insert(eventSubscriptions).values({
      id: "legacy-row", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "legacy",
      eventKeys: ["github.pull_request.opened"], filters: [],
      target: { kind: "orchestrator", orchestrator: "user", presence: { displayName: "Legacy helper" } },
      enabled: true, createdBy: "local-user", createdAt: now, updatedAt: now,
    });
    const list = await (await fetch(`${a.baseUrl}/api/event-subscriptions`)).json() as ListEventSubscriptionsResponse;
    expect(list.subscriptions.find((s) => s.id === "legacy-row")?.target).toEqual({
      kind: "assistant", assistant: "user", appearance: { displayName: "Legacy helper" },
    });
    // A patch rewrites the row it touches with the new names.
    const renamed = await patchSubscription(a.baseUrl, "legacy-row", { name: "renamed" });
    expect(renamed.status).toBe(200);
    expect(await storedTarget(a, "legacy-row")).toEqual({ kind: "assistant", assistant: "user", appearance: { displayName: "Legacy helper" } });
  });
});
