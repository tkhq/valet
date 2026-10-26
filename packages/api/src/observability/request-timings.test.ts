import { afterEach, expect, it } from "vitest";
import { recordRequestTiming, requestTimingSummary, resetRequestTimings } from "./request-timings.js";

afterEach(() => resetRequestTimings());

it("keeps counting real routes after the route budget is spent", () => {
  const at = Date.now();
  for (let i = 0; i < 600; i++) recordRequestTiming(`GET /unmatched-${i}`, { at, ms: 1, status: 404 });
  recordRequestTiming("GET /api/sessions/:id/threads", { at, ms: 900, status: 500, orgId: "victim-org" });
  const { routes } = requestTimingSummary({ orgId: "victim-org", sinceMs: at - 1, limit: 3 });
  expect(routes[0]).toMatchObject({ route: "(other routes)", count: 101, maxMs: 900, serverErrors: 1 });
});

it("summarizes one organization's requests and requests with no organization", () => {
  const at = Date.now();
  recordRequestTiming("GET /api/threads/:threadId/messages", { at, ms: 100, status: 200, orgId: "org-a" });
  recordRequestTiming("GET /api/threads/:threadId/messages", { at, ms: 300, status: 200 });
  recordRequestTiming("GET /api/threads/:threadId/messages", { at, ms: 5_000, status: 200, orgId: "org-b" });
  const { routes } = requestTimingSummary({ orgId: "org-a", sinceMs: at - 1, limit: 5 });
  expect(routes).toEqual([expect.objectContaining({ count: 2, totalMs: 400, maxMs: 300 })]);
});

it("records an unmatched request under one row, not its raw path", async () => {
  const { bootTestApi } = await import("../integration/_setup.js");
  const api = await bootTestApi();
  try {
    resetRequestTimings();
    for (let i = 0; i < 3; i++) expect((await fetch(`${api.baseUrl}/no-such-page-${i}`)).status).toBe(404);
    await fetch(`${api.baseUrl}/api/me`);
    const { routes } = requestTimingSummary({ orgId: "local-org", sinceMs: 0, limit: 10 });
    expect(routes.map((route) => route.route)).toEqual(expect.arrayContaining(["GET (no matching route)", "GET /api/me"]));
    expect(routes.some((route) => route.route.includes("no-such-page"))).toBe(false);
  } finally {
    await api.cleanup();
  }
});
