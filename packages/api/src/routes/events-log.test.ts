import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions, slackChannelPrivacy } from "../schema/index.js";
import type { EventLogResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function seed(a: TestApi) {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: "sub_mine", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Mine",
    eventKeys: ["github.push", "slack.*"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
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
  return await (await fetch(`${a.baseUrl}/api/events/log?${MINE}&diagnostics=1${query}`, { headers })).json() as EventLogResponse;
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

/** A real cursor with its `at` replaced, as a forged request would send it. */
function forged(cursor: string, at: number): string {
  const fields: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (typeof fields !== "object" || fields === null) throw new Error("the cursor is not an object");
  return Buffer.from(JSON.stringify({ ...fields, at }), "utf8").toString("base64url");
}

// Review A3: a forged cursor time is a 400 that names the fix, not a 500 that echoes SQL.
it("refuses a cursor whose time is not a safe whole number", async () => {
  api = await bootTestApi();
  await seed(api);
  const first = await log(api, "&limit=2");
  for (const at of [1.5, 1e300]) {
    const res = await fetch(`${api.baseUrl}/api/events/log?${MINE}&diagnostics=1&limit=2&cursor=${forged(first.nextCursor!, at)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The page cursor is not valid for these filters. Reload Activity and try again." });
  }
});

it("counts only this workspace's deliveries, and shows why a skipped event was skipped", async () => {
  api = await bootTestApi();
  await seed(api);
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_theirs", orgId: "local-org", ownerType: "team", ownerId: "team-b", name: "Theirs",
    eventKeys: ["github.push"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  await api.providers.db.insert(events).values({
    id: "ev_skip", orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: "ev_skip", refs: {}, summary: "push ev_skip",
    payload: {}, occurredAt: now - 500, receivedAt: now - 500,
  });
  await api.providers.db.insert(eventDeliveries).values([
    // Another workspace's dead delivery of an event this workspace received.
    { id: "d3", eventId: "ev_ok", subscriptionId: "sub_theirs", status: "dead", attempts: 5, nextAttemptAt: 0, createdAt: now },
    { id: "d4", eventId: "ev_skip", subscriptionId: "sub_mine", status: "skipped", lastError: "The team already listens for this.", attempts: 0, nextAttemptAt: 0, createdAt: now },
  ]);
  const body = await log(api);
  expect(body.items.find((item) => item.id === "ev_ok")).toMatchObject({ status: "delivered", deliveryCount: 1 });
  expect(body.items.find((item) => item.id === "ev_skip")).toMatchObject({ status: "skipped", detail: "The team already listens for this." });
  expect((await log(api, "&problems=1")).items.map((item) => item.id)).not.toContain("ev_ok");
});

it("keeps other workspaces' events out, and hides form diagnostics from members", async () => {
  api = await bootTestApi();
  await seed(api);
  const other = await (await fetch(`${api.baseUrl}/api/events/log?ownerType=team&ownerId=other&diagnostics=1`)).json() as EventLogResponse;
  // The org-wide form diagnostic shows; the filter miss belongs to a rule this workspace does not have.
  expect(other.items.map((item) => item.id)).toEqual(["drop_form"]);
  const member = await (await fetch(`${api.baseUrl}/api/events/log?ownerType=user&ownerId=test-member`, { headers: { "x-valet-test-user-id": "test-member" } })).json() as EventLogResponse;
  expect(member.items.map((item) => item.id)).not.toContain("drop_form");
});

it("shows a filter miss only where a workspace's rules, or the org's, name its event key", async () => {
  api = await bootTestApi();
  await seed(api);
  const now = Date.now();
  await api.providers.db.insert(eventDropLog).values({
    id: "drop_pr", orgId: "local-org", reason: "filter_excluded", detail: "pull request filtered", eventKey: "github.pull_request.opened", createdAt: now - 500,
  });
  const ids = async (ownerType: string, ownerId: string) => ((await (await fetch(
    `${api!.baseUrl}/api/events/log?ownerType=${ownerType}&ownerId=${ownerId}&diagnostics=1`)).json()) as EventLogResponse).items.map((item) => item.id);
  // This workspace subscribes to github.push and slack.*, never to pull requests.
  // A disabled rule for the key does not count: ingest never checked it.
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_off", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Off",
    eventKeys: ["github.*"], filters: [], target: { kind: "assistant" }, enabled: false, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  expect(await ids("user", "local-user")).not.toContain("drop_pr");
  expect(await ids("user", "local-user")).toContain("drop_filter");
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_reviews", orgId: "local-org", ownerType: "team", ownerId: "reviews", name: "Reviews",
    eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  expect(await ids("team", "reviews")).toContain("drop_pr");
  expect(await ids("user", "local-user")).not.toContain("drop_pr");
  // An org-owned rule for the key shows the miss in every workspace.
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_org_prs", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "Org PRs",
    eventKeys: ["github.*"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  expect(await ids("user", "local-user")).toContain("drop_pr");
});

it("includes events an org-owned rule received, skips other orgs, and looks back 30 days", async () => {
  api = await bootTestApi();
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_org", orgId: "local-org", ownerType: "org", ownerId: "local-org", name: "Org rule",
    eventKeys: ["github.push"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
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

it("keeps disabled subscription history while hiding new webhook diagnostics by default", async () => {
  api = await bootTestApi();
  await seed(api);
  await api.providers.db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "sub_mine"));
  await api.providers.db.insert(eventDropLog).values({ id: "incoming_after_disable", orgId: "local-org", reason: "no_subscription_match", detail: "No active subscription", createdAt: Date.now() });
  const read = async () => (await (await fetch(`${api!.baseUrl}/api/events/log?${MINE}&limit=1`)).json()) as EventLogResponse;
  const first = await read();
  expect(first.items.map(item => item.id)).toEqual(["ev_ok"]);
  expect(first.nextCursor).toBeTruthy();
  const second = await (await fetch(`${api.baseUrl}/api/events/log?${MINE}&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as EventLogResponse;
  expect(second.items.map(item => item.id)).toEqual(["ev_bad"]);
  expect(second.nextCursor).toBeNull();
  expect((await log(api)).items.some(item => item.id === "incoming_after_disable")).toBe(true);
  expect((await fetch(`${api.baseUrl}/api/events/log?${MINE}&diagnostics=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
});

it("names each stored event's place from its natural subject (presence hub Part E)", async () => {
  api = await bootTestApi({ plugins: [slackPlugin, githubPlugin] });
  await seed(api);
  const now = Date.now();
  await api.providers.db.insert(events).values([
    {
      id: "ev_mention", orgId: "local-org", service: "slack", eventKey: "slack.app_mention", dedupeKey: "ev_mention",
      refs: { channel: "C900", channel_name: "incidents" }, subjects: ["slack:T1", "slack:T1/C900", "slack:T1/C900/1700.1"],
      summary: "mention", payload: {}, occurredAt: now - 200, receivedAt: now - 200,
    },
    {
      id: "ev_pr", orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: "ev_pr",
      refs: {}, subjects: ["github:acme/api", "github:acme/api#12"], summary: "pr", payload: {}, occurredAt: now - 300, receivedAt: now - 300,
    },
  ]);
  await api.providers.db.insert(eventDeliveries).values([
    { id: "d_mention", eventId: "ev_mention", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now },
    { id: "d_pr", eventId: "ev_pr", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now },
  ]);
  // A Slack event shows only when its channel is known to be public.
  await api.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "C900", isPrivate: false, checkedAt: Date.now() });
  const items = new Map((await log(api)).items.map((item) => [item.id, item]));
  expect(items.get("ev_mention")?.place).toBe("#incidents");
  expect(items.get("ev_mention")?.placeKey).toBe("slack:T1/C900");
  expect(items.get("ev_pr")?.place).toBe("acme/api#12");
  expect(items.get("ev_pr")?.placeKey).toBe("github:acme/api#12");
  // An event whose subjects name no place carries none.
  expect(items.get("ev_ok")).not.toHaveProperty("place");
  expect(items.get("ev_ok")).not.toHaveProperty("placeKey");
  // A problem row is not an event and carries neither.
  expect(items.get("drop_filter")).not.toHaveProperty("place");
  expect(items.get("drop_filter")).not.toHaveProperty("deliveries");
});

it("keeps only the events in a place, or inside it, when the Log reads place= (presence hub Part E)", async () => {
  api = await bootTestApi({ plugins: [slackPlugin, githubPlugin] });
  await seed(api);
  const now = Date.now();
  const githubEvent = (id: string, subjects: string[], at: number) => ({
    id, orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: id,
    refs: {}, subjects, summary: id, payload: {}, occurredAt: at, receivedAt: at,
  });
  await api.providers.db.insert(events).values([
    githubEvent("ev_repo", ["github:acme/api"], now - 100),
    githubEvent("ev_pull", ["github:acme/api", "github:acme/api#12"], now - 200),
    githubEvent("ev_other", ["github:acme/web"], now - 300),
  ]);
  await api.providers.db.insert(eventDeliveries).values(["ev_repo", "ev_pull", "ev_other"].map((eventId) => ({
    id: `d_${eventId}`, eventId, subscriptionId: "sub_mine", status: "delivered" as const, attempts: 1, nextAttemptAt: 0, createdAt: now,
  })));
  const ids = async (place: string) =>
    (await log(api!, `&place=${encodeURIComponent(place)}`)).items.map((item) => item.id);
  // The repository covers its pull request; problems name no place and stay out.
  expect(await ids("github:acme/api")).toEqual(["ev_repo", "ev_pull"]);
  expect(await ids("github:acme/api#12")).toEqual(["ev_pull"]);
  // The service-wide place covers every repository.
  expect(await ids("github:*")).toEqual(["ev_repo", "ev_pull", "ev_other"]);
  const bad = await fetch(`${api.baseUrl}/api/events/log?${MINE}&place=nowhere`);
  expect(bad.status).toBe(400);
});

// Review A2: a page whose bounded scan kept no row is empty, and its cursor
// reads on from where the scan stopped, so the reader can reach older rows.
it("returns a cursor at the scan frontier when a place page scanned past every row", async () => {
  api = await bootTestApi({ plugins: [githubPlugin] });
  await seed(api);
  const now = Date.now();
  const githubEvent = (id: string, subjects: string[], at: number) => ({
    id, orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: id,
    refs: {}, subjects, summary: id, payload: {}, occurredAt: at, receivedAt: at,
  });
  const others = Array.from({ length: 45 }, (_, i) => githubEvent(`ev_web_${i}`, ["github:acme/web"], now - 100 - i));
  await api.providers.db.insert(events).values([...others, githubEvent("ev_api", ["github:acme/api"], now - 500)]);
  await api.providers.db.insert(eventDeliveries).values([...others.map((e) => e.id), "ev_api"].map((eventId) => ({
    id: `d_${eventId}`, eventId, subscriptionId: "sub_mine", status: "delivered" as const, attempts: 1, nextAttemptAt: 0, createdAt: now,
  })));
  const place = `&limit=1&place=${encodeURIComponent("github:acme/api")}`;
  const first = await log(api, place);
  expect(first.items).toEqual([]);
  expect(first.nextCursor).toBeTruthy();
  const second = await log(api, `${place}&cursor=${encodeURIComponent(first.nextCursor!)}`);
  expect(second.items.map((item) => item.id)).toEqual(["ev_api"]);
  expect(second.nextCursor).toBeNull();
});

it("lists each stored event's deliveries to this workspace's rules, newest first", async () => {
  api = await bootTestApi();
  await seed(api);
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_theirs", orgId: "local-org", ownerType: "team", ownerId: "team-b", name: "Theirs",
    eventKeys: ["github.push"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  await api.providers.db.insert(eventDeliveries).values([
    { id: "d_theirs", eventId: "ev_ok", subscriptionId: "sub_theirs", status: "dead", attempts: 5, nextAttemptAt: 0, createdAt: now + 1 },
    { id: "d_skip", eventId: "ev_ok", subscriptionId: "sub_mine", status: "skipped", lastError: "Skipped by delivery preferences", attempts: 0, nextAttemptAt: 0, createdAt: now + 2 },
  ]);
  const ok = (await log(api)).items.find((item) => item.id === "ev_ok");
  expect(ok?.deliveries?.map((d) => [d.id, d.status, d.subscriptionName])).toEqual([
    ["d_skip", "skipped", "Mine"], ["d1", "delivered", "Mine"],
  ]);
  expect(ok?.deliveries?.[0]?.lastError).toBe("Skipped by delivery preferences");
});

// A redelivery settles a dead delivery for the same line, so the event reads
// delivered and the dead row names the delivery that settled it.
it("marks a dead delivery superseded when a later delivery for the same line was delivered", async () => {
  api = await bootTestApi();
  await seed(api);
  const now = Date.now();
  await api.providers.db.insert(eventSubscriptions).values({
    id: "sub_two", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Two",
    eventKeys: ["github.push"], filters: [], target: { kind: "assistant" }, enabled: true, createdBy: "local-user", createdAt: 1, updatedAt: 1,
  });
  await api.providers.db.insert(eventDeliveries).values([
    // ev_bad's dead d2 (sub_mine) gets a later delivered redelivery.
    { id: "d2_redo", eventId: "ev_bad", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now + 10 },
  ]);
  const body = await log(api);
  const bad = body.items.find((item) => item.id === "ev_bad");
  expect(bad?.status).toBe("delivered");
  expect(bad?.deliveries?.find((d) => d.id === "d2")).toMatchObject({ status: "dead", supersededBy: "d2_redo" });
  expect(bad?.deliveries?.find((d) => d.id === "d2_redo")?.supersededBy).toBeUndefined();
  expect((await log(api, "&problems=1")).items.map((item) => item.id)).not.toContain("ev_bad");

  // A delivered row for another line, or an earlier one, settles nothing.
  await api.providers.db.insert(events).values({
    id: "ev_mixed", orgId: "local-org", service: "github", eventKey: "github.push", dedupeKey: "ev_mixed", refs: {}, summary: "push ev_mixed",
    payload: {}, occurredAt: now - 200, receivedAt: now - 200,
  });
  await api.providers.db.insert(eventDeliveries).values([
    { id: "m_early", eventId: "ev_mixed", subscriptionId: "sub_mine", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now - 100 },
    { id: "m_dead", eventId: "ev_mixed", subscriptionId: "sub_mine", status: "dead", attempts: 4, nextAttemptAt: 0, createdAt: now },
    { id: "m_other", eventId: "ev_mixed", subscriptionId: "sub_two", status: "delivered", attempts: 1, nextAttemptAt: 0, createdAt: now + 10 },
  ]);
  const mixed = (await log(api)).items.find((item) => item.id === "ev_mixed");
  expect(mixed?.status).toBe("failed");
  expect(mixed?.deliveries?.find((d) => d.id === "m_dead")?.supersededBy).toBeUndefined();
  expect((await log(api, "&problems=1")).items.map((item) => item.id)).toContain("ev_mixed");
});
