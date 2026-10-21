import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { webPresence } from "../services/web-presence.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("reports only the authenticated user's tabs", async () => {
  api = await bootTestApi({ auth: true });
  const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Presence", email: "presence@example.test", password: "correct-horse-battery" }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
  if (!cookie) throw new Error("Expected browser session cookie");
  const { user } = await signup.json() as { user: { id: string } };
  const post = (body: object) => fetch(`${api!.baseUrl}/api/notifications/presence`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: api!.baseUrl }, body: JSON.stringify(body),
  });
  expect((await post({ tabId: "a", active: true, userId: "test-member" })).status).toBe(200);
  expect((await post({ tabId: "b", active: true })).status).toBe(200);
  expect((await post({ tabId: "a", active: false })).status).toBe(200);
  expect(webPresence(api.providers.db).isActive(user.id)).toBe(true);
  expect(webPresence(api.providers.db).isActive("test-member")).toBe(false);
  expect((await post({ tabId: "b", active: false })).status).toBe(200);
  expect(webPresence(api.providers.db).isActive(user.id)).toBe(false);
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
