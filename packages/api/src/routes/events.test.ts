/**
 * `/api/events*` + `/api/event-subscriptions` route tests (event-system plan,
 * Task 7). Real Hono app via `bootTestApi` with the real github plugin's
 * trigger catalog; rows seeded straight through `providers.db`; cross-org
 * cases seed rows under a second org id (stub auth pins the caller to
 * `local-org`, so "another org" is expressed in data, not identity).
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: [githubPlugin] });
  return api;
}

const VALID_BODY: CreateEventSubscriptionRequest = {
  name: "pr opens",
  eventKeys: ["github.pull_request.opened"],
  filters: [{ field: "repo", op: "eq", value: "acme/widgets" }],
  target: { kind: "orchestrator" },
};

async function postSubscription(
  baseUrl: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/api/event-subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Seeds a subscription row directly (bypassing route validation) — used for
 * cross-org 404 cases where the route would refuse to create the row. */
async function seedSubscriptionRow(a: TestApi, id: string, orgId: string): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id,
    orgId,
    ownerType: "user",
    ownerId: "someone",
    name: `seeded ${id}`,
    eventKeys: ["github.push"],
    filters: [],
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEventRow(
  a: TestApi,
  args: { id: string; orgId?: string; service?: string; eventKey?: string; receivedAt: number },
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
  });
});

describe("POST /api/event-subscriptions", () => {
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

  it("orchestrator target with orchestrator=org writes an org-owned row", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      target: { kind: "orchestrator", orchestrator: "org" },
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

  it("400s a bad filter op, naming it", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, {
      ...VALID_BODY,
      filters: [{ field: "repo", op: "regex", value: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex");
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

  it("400s a missing name", async () => {
    const a = await boot();
    const res = await postSubscription(a.baseUrl, { ...VALID_BODY, name: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("name");
  });
});

describe("GET /api/event-subscriptions", () => {
  it("lists only the caller's org's subscriptions", async () => {
    const a = await boot();
    const created = await postSubscription(a.baseUrl, VALID_BODY);
    expect(created.status).toBe(201);
    await seedSubscriptionRow(a, "sub_foreign", "other-org");

    const res = await fetch(`${a.baseUrl}/api/event-subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventSubscriptionsResponse;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].name).toBe("pr opens");
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
});

describe("GET /api/events", () => {
  it("returns the org's events newest-first, excluding other orgs", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_old", receivedAt: 1_000 });
    await seedEventRow(a, { id: "ev_new", receivedAt: 3_000 });
    await seedEventRow(a, { id: "ev_mid", receivedAt: 2_000 });
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 4_000 });

    const res = await fetch(`${a.baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEventsResponse;
    expect(body.events.map((e) => e.id)).toEqual(["ev_new", "ev_mid", "ev_old"]);
    expect(body.events[0].summary).toBe("event ev_new");
    expect(body.events[0].refs).toEqual({ repo: "acme/widgets" });
  });

  it("filters by service and key, and honors limit", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_a", eventKey: "github.pull_request.opened", receivedAt: 1_000 });
    await seedEventRow(a, { id: "ev_b", eventKey: "github.push", receivedAt: 2_000 });
    await seedEventRow(a, { id: "ev_c", service: "linear", eventKey: "linear.issue.create", receivedAt: 3_000 });

    const byKey = (await (await fetch(`${a.baseUrl}/api/events?key=github.push`)).json()) as ListEventsResponse;
    expect(byKey.events.map((e) => e.id)).toEqual(["ev_b"]);

    const byService = (await (await fetch(`${a.baseUrl}/api/events?service=github`)).json()) as ListEventsResponse;
    expect(byService.events.map((e) => e.id)).toEqual(["ev_b", "ev_a"]);

    const limited = (await (await fetch(`${a.baseUrl}/api/events?limit=1`)).json()) as ListEventsResponse;
    expect(limited.events.map((e) => e.id)).toEqual(["ev_c"]);
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
  });

  it("404s an event belonging to another org", async () => {
    const a = await boot();
    await seedEventRow(a, { id: "ev_foreign", orgId: "other-org", receivedAt: 1_000 });

    const res = await fetch(`${a.baseUrl}/api/events/ev_foreign`);
    expect(res.status).toBe(404);
  });
});
