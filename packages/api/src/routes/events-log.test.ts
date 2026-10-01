import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions } from "../schema/index.js";
import type { EventLogResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function seed(a: TestApi) {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: "sub_mine", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Mine",
    eventKeys: ["github.push"], filters: [], target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  const event = (id: string, at: number) => ({
    id, orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: id, refs: {}, summary: `push ${id}`,
    payload: {}, occurredAt: at, receivedAt: at,
  });
  await a.providers.db.insert(events).values([event("ev_ok", now - 1_000), event("ev_bad", now - 3_000)]);
  await a.providers.db.insert(eventDeliveries).values([
    { id: "d1", eventId: "ev_ok", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now },
    { id: "d2", eventId: "ev_bad", subscriptionId: "sub_mine", status: "dead", attempts: 4, nextAttemptAt: 0, createdAt: now },
  ]);
  await a.providers.db.insert(eventDropLog).values([
    { id: "drop_filter", orgId: "local-org", reason: "filter_excluded", detail: "text did not match", eventKey: "slack.message", createdAt: now - 2_000 },
    { id: "drop_form", orgId: "local-org", reason: "slack_interaction_unmatched", detail: "a form click", createdAt: now - 4_000 },
  ]);
}

const MINE = "ownerType=user&ownerId=local-user";

async function log(a: TestApi, query = "", headers: Record<string, string> = {}) {
  return await (await fetch(`${a.baseUrl}/api/events/log?${MINE}${query}`, { headers })).json() as EventLogResponse;
}

it("merges the workspace's events and the org's problems newest first, each with one status", async () => {
  api = await bootTestApi();
  await seed(api);
  const body = await log(api);
  expect(body.items.map((item) => [item.id, item.status])).toEqual([
    ["ev_ok", "delivered"], ["drop_filter", "filtered"], ["ev_bad", "failed"], ["drop_form", "rejected"],
  ]);
  expect(body.lastEventAt).toBeTypeOf("number");
  expect(body.windowDays).toBe(30);
});

it("keeps only problems and failed events, and searches both kinds", async () => {
  api = await bootTestApi();
  await seed(api);
  expect((await log(api, "&problems=1")).items.map((item) => item.id)).toEqual(["drop_filter", "ev_bad", "drop_form"]);
  expect((await log(api, "&q=did%20not")).items.map((item) => item.id)).toEqual(["drop_filter"]);
  expect((await fetch(`${api.baseUrl}/api/events/log`)).status).toBe(400);
});

it("pages the merged list with one cursor, and refuses it under other filters", async () => {
  api = await bootTestApi();
  await seed(api);
  const first = await log(api, "&limit=2");
  expect(first.items.map((item) => item.id)).toEqual(["ev_ok", "drop_filter"]);
  expect(first.nextCursor).toBeTruthy();
  const second = await log(api, `&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
  expect(second.items.map((item) => item.id)).toEqual(["ev_bad", "drop_form"]);
  expect(second.nextCursor).toBeNull();
  expect((await fetch(`${api.baseUrl}/api/events/log?${MINE}&problems=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
});

it("keeps other workspaces' events out, and hides form diagnostics from members", async () => {
  api = await bootTestApi();
  await seed(api);
  const other = await (await fetch(`${api.baseUrl}/api/events/log?ownerType=team&ownerId=other`)).json() as EventLogResponse;
  expect(other.items.map((item) => item.kind)).toEqual(["problem", "problem"]);
  const member = await (await fetch(`${api.baseUrl}/api/events/log?ownerType=user&ownerId=test-member`, { headers: { "x-valet-test-user-id": "test-member" } })).json() as EventLogResponse;
  expect(member.items.map((item) => item.id)).not.toContain("drop_form");
});

it("includes events an org-owned rule received, skips other orgs, and looks back 30 days", async () => {
  api = await bootTestApi();
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_org", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "Org rule",
    eventKeys: ["github.push"], filters: [], target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  const event = (id: string, orgId: string, at: number) => ({
    id, orgId, service: "github", eventKey: "github.push", dedupeKey: id, refs: {}, summary: id, payload: {}, occurredAt: at, receivedAt: at,
  });
  await api.providers.db.insert(events).values([
    event("ev_org", "local-org", now - 1_000), event("ev_old", "local-org", now - 31 * 86_400_000), event("ev_foreign", "other-org", now),
  ]);
  await api.providers.db.insert(eventDeliveries).values(["ev_org", "ev_old", "ev_foreign"].map((eventId) => ({
    id: `d_${eventId}`, eventId, subscriptionId: "sub_org", status: "delivered" as const, attempts: 1, nextAttemptAt: 0, createdAt: now,
  })));
  expect((await log(api)).items.map((item) => item.id)).toEqual(["ev_org"]);
});
