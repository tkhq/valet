import { afterEach, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { linkIdentity } from "../channels/identity-links.js";
import { eventDeliveries, eventSubscriptions, events, teamMembers, teams, workflowDefinitions } from "../schema/index.js";
import { resetThreadAccessCache } from "../services/thread-access.js";

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

it("shows a private Slack channel's events only to the channel's members", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "local-user" });
  const event = (id: string, service: string, eventKey: string, payload: Record<string, unknown>, refs: Record<string, string> = {}) => ({
    id, orgId: "local-org", service, eventKey, dedupeKey: id, refs, summary: eventKey, payload, occurredAt: 1, receivedAt: 1,
  });
  await api.providers.db.insert(events).values([
    event("private-message", "slack", "slack.message", { channel: "CPRIV", text: "private plan" }, { channel: "CPRIV" }),
    event("private-reaction", "slack", "slack.reaction_added", { item: { channel: "CPRIV", ts: "1.1" } }, { channel: "CPRIV" }),
    // A row stored before ingest copied the channel to refs.
    event("private-reaction-old", "slack", "slack.reaction_added", { item: { channel: "CPRIV", ts: "1.1" } }),
    event("public-message", "slack", "slack.message", { channel: "CPUB", text: "hello" }, { channel: "CPUB" }),
    event("github-push", "github", "github.push", { ref: "main" }),
  ]);
  const get = (id: string, user?: string) =>
    fetch(`${api!.baseUrl}/api/events/${id}`, user ? { headers: { "x-valet-test-user-id": user } } : {});

  for (const id of ["private-message", "private-reaction", "private-reaction-old"]) {
    expect((await get(id)).status).toBe(200);
    expect((await get(id, "test-member")).status).toBe(404);
  }
  expect((await fetch(`${api.baseUrl}/api/events/private-message/redeliver`, {
    method: "POST", headers: { "x-valet-test-user-id": "test-member" },
  })).status).toBe(404);
  expect((await get("public-message", "test-member")).status).toBe(200);
  expect((await get("github-push", "test-member")).status).toBe(200);
});

it("shows a workflow run a private Slack channel's event started only to the channel's members", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "local-user" });
  const p = api.providers;
  await p.db.insert(teams).values({ id: "team-ev", orgId: "local-org", name: "Events", createdAt: 1 });
  await p.db.insert(teamMembers).values([
    { teamId: "team-ev", userId: "local-user", role: "member" },
    { teamId: "team-ev", userId: "test-member", role: "member" },
  ]);
  await p.db.insert(workflowDefinitions).values({ id: "wf-ev", orgId: "local-org", ownerType: "team", ownerId: "team-ev", name: "Digest", definition: {}, createdAt: 1, updatedAt: 1 });
  const start = (runId: string, channel: string) => p.workflowStore.createRun(runId, {
    workflowId: "wf-ev", definitionVersionId: "v1",
    input: { type: "event", timestamp: "2026-10-04T00:00:00.000Z", data: { key: "slack.message", refs: { channel }, payload: { channel, text: "secret plan" } }, metadata: {} },
  }, { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: "team-ev" });
  await start("run-private", "CPRIV");
  await start("run-public", "CPUB");
  const get = (runId: string, user?: string) =>
    fetch(`${api!.baseUrl}/api/workflows/runs/${runId}`, user ? { headers: { "x-valet-test-user-id": user } } : {});

  expect((await get("run-private")).status).toBe(200);
  expect((await get("run-private", "test-member")).status).toBe(404);
  expect((await get("run-public", "test-member")).status).toBe(200);
});

it("leaves a private Slack channel's events out of a non-member's Log", async () => {
  api = await bootTestApi();
  await connectSlack(api, { CPRIV: ["UMEMBER"] });
  await linkIdentity(api.providers.db, { provider: "slack", externalId: "UMEMBER", userId: "local-user" });
  const db = api.providers.db;
  await db.insert(teams).values({ id: "team-log", orgId: "local-org", name: "Log", createdAt: 1 });
  await db.insert(teamMembers).values([
    { teamId: "team-log", userId: "local-user", role: "member" },
    { teamId: "team-log", userId: "test-member", role: "member" },
  ]);
  await db.insert(eventSubscriptions).values({ id: "sub-log", orgId: "local-org", ownerType: "team", ownerId: "team-log", name: "Slack", eventKeys: ["slack.*"], filters: [], target: { kind: "orchestrator" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1 });
  const now = Date.now();
  for (const [id, channel] of [["log-private", "CPRIV"], ["log-public", "CPUB"]] as const) {
    await db.insert(events).values({ id, orgId: "local-org", service: "slack", eventKey: "slack.message", dedupeKey: id, refs: { channel }, summary: `message in ${channel}`, payload: { channel }, occurredAt: now, receivedAt: now });
    await db.insert(eventDeliveries).values({ id: `d-${id}`, eventId: id, subscriptionId: "sub-log", status: "delivered", attempts: 1, nextAttemptAt: now, createdAt: now });
  }
  const log = async (user?: string) => ((await (await fetch(`${api!.baseUrl}/api/events/log?ownerType=team&ownerId=team-log`,
    user ? { headers: { "x-valet-test-user-id": user } } : {})).json()) as { items: Array<{ id: string }> }).items.map((i) => i.id).sort();
  expect(await log()).toEqual(["log-private", "log-public"]);
  expect(await log("test-member")).toEqual(["log-public"]);
});
