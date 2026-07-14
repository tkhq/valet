/**
 * Notifications routes — GET /api/notifications[?unread=1],
 * POST /api/notifications/:id/read, POST /api/notifications/read-all.
 *
 * Drives a real `createApp` (via bootTestApi) over HTTP; seeds rows
 * directly via `routeAttention` so the route tests are independent of the
 * attention-router's own unit tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../src/integration/_setup.js";
import { routeAttention } from "../src/orchestrator/attention.js";
import type { ListNotificationsResponse } from "../src/wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

describe("notifications routes", () => {
  it("lists only the caller's own notifications, newest first", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;

    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "second" });
    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "test-member" }, title: "not mine" });

    const res = await fetch(`${baseUrl}/api/notifications`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const { notifications } = (await res.json()) as ListNotificationsResponse;
    expect(notifications.map((n) => n.title)).toEqual(["second", "first"]);
  });

  it("filters to unread only when ?unread=1", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;

    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "will read" });
    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "stays unread" });

    const listRes = await fetch(`${baseUrl}/api/notifications`, { headers: HEADERS });
    const { notifications } = (await listRes.json()) as ListNotificationsResponse;
    const toRead = notifications.find((n) => n.title === "will read");
    expect(toRead).toBeDefined();

    const readRes = await fetch(`${baseUrl}/api/notifications/${toRead!.id}/read`, { method: "POST", headers: HEADERS });
    expect(readRes.status).toBe(200);

    const unreadRes = await fetch(`${baseUrl}/api/notifications?unread=1`, { headers: HEADERS });
    const { notifications: unread } = (await unreadRes.json()) as ListNotificationsResponse;
    expect(unread.map((n) => n.title)).toEqual(["stays unread"]);
  });

  it("mark-read on another user's notification 404s (own-rows-only)", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;

    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "mine" });
    const listRes = await fetch(`${baseUrl}/api/notifications`, { headers: HEADERS });
    const { notifications } = (await listRes.json()) as ListNotificationsResponse;
    const id = notifications[0]!.id;

    const res = await fetch(`${baseUrl}/api/notifications/${id}/read`, { method: "POST", headers: MEMBER_HEADERS });
    expect(res.status).toBe(404);
  });

  it("read-all clears every unread notification for the caller only", async () => {
    api = await bootTestApi();
    const { baseUrl, providers } = api;

    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "a" });
    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "local-user" }, title: "b" });
    await routeAttention(providers, { kind: "notification", owner: { type: "user", id: "test-member" }, title: "c" });

    const res = await fetch(`${baseUrl}/api/notifications/read-all`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);

    const localUnread = await fetch(`${baseUrl}/api/notifications?unread=1`, { headers: HEADERS });
    expect(((await localUnread.json()) as ListNotificationsResponse).notifications).toHaveLength(0);

    const memberUnread = await fetch(`${baseUrl}/api/notifications?unread=1`, { headers: MEMBER_HEADERS });
    expect(((await memberUnread.json()) as ListNotificationsResponse).notifications).toHaveLength(1);
  });
});
