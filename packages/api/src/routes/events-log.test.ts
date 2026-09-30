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

async function log(a: TestApi, query = "", headers: Record<string, string> = {}) {
  return await (await fetch(`${a.baseUrl}/api/events/log${query}`, { headers })).json() as EventLogResponse;
}

it("merges events and problems newest first, each with one status", async () => {
  api = await bootTestApi();
  await seed(api);
  const body = await log(api);
  expect(body.items.map((item) => [item.id, item.status])).toEqual([
    ["ev_ok", "delivered"], ["drop_filter", "filtered"], ["ev_bad", "failed"], ["drop_form", "rejected"],
  ]);
  expect(body.lastEventAt).toBeTypeOf("number");
  expect(body.windowDays).toBeNull();
});

it("narrows to one status and searches both kinds", async () => {
  api = await bootTestApi();
  await seed(api);
  expect((await log(api, "?status=failed")).items.map((item) => item.id)).toEqual(["ev_bad"]);
  expect((await log(api, "?status=filtered")).items.map((item) => item.id)).toEqual(["drop_filter"]);
  expect((await log(api, "?q=did%20not")).items.map((item) => item.id)).toEqual(["drop_filter"]);
  expect((await fetch(`${api.baseUrl}/api/events/log?status=bogus`)).status).toBe(400);
});

it("pages the merged list with one cursor, and refuses it under other filters", async () => {
  api = await bootTestApi();
  await seed(api);
  const first = await log(api, "?limit=2");
  expect(first.items.map((item) => item.id)).toEqual(["ev_ok", "drop_filter"]);
  expect(first.nextCursor).toBeTruthy();
  const second = await log(api, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
  expect(second.items.map((item) => item.id)).toEqual(["ev_bad", "drop_form"]);
  expect(second.nextCursor).toBeNull();
  expect((await fetch(`${api.baseUrl}/api/events/log?status=failed&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
});

it("scopes events to a workspace and hides form diagnostics from members", async () => {
  api = await bootTestApi();
  await seed(api);
  const scoped = await log(api, "?ownerType=team&ownerId=other");
  expect(scoped.items.map((item) => item.kind)).toEqual(["problem", "problem"]);
  expect(scoped.windowDays).toBe(30);
  const member = await log(api, "", { "x-valet-test-user-id": "test-member" });
  expect(member.items.map((item) => item.id)).not.toContain("drop_form");
});
