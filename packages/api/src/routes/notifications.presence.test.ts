import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { webPresence } from "../services/web-presence.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("reports only the authenticated user's tabs", async () => {
  api = await bootTestApi();
  const post = (body: object) => fetch(`${api!.baseUrl}/api/notifications/presence`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post({ tabId: "a", active: true, userId: "test-member" })).status).toBe(200);
  expect((await post({ tabId: "b", active: true })).status).toBe(200);
  expect((await post({ tabId: "a", active: false })).status).toBe(200);
  expect(webPresence(api.providers.db).isActive("local-user")).toBe(true);
  expect(webPresence(api.providers.db).isActive("test-member")).toBe(false);
  expect((await post({ tabId: "b", active: false })).status).toBe(200);
  expect(webPresence(api.providers.db).isActive("local-user")).toBe(false);
  expect((await post({ tabId: "", active: true })).status).toBe(400);
  expect((await post({ tabId: "a", active: "yes" })).status).toBe(400);
});

it("rejects anonymous presence requests", async () => {
  api = await bootTestApi({ auth: true });
  const response = await fetch(`${api.baseUrl}/api/notifications/presence`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tabId: "a", active: true }),
  });
  expect(response.status).toBe(401);
});
