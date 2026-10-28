import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { externalCalls } from "../schema/index.js";
import { cliUsage } from "./cli-usage.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
it.each([
  [{ error: "Forbidden" }, "forbidden"],
  [{ errorCode: "policy_denied", error: "Blocked by policy" }, "policy_denied"],
])("classifies HTTP 403 from its body: %s", async (body, errorCode) => {
  const testApi = await bootTestApi(); api = testApi;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("providers", testApi.providers);
    c.set("user", { id: "local-user", email: "test@example.com", orgId: "local-org", role: "admin" });
    c.set("principal", { type: "user", id: "local-user" });
    await next();
  });
  app.use("*", cliUsage());
  app.get("/api/example", c => c.json(body, 403));
  const result = await app.request("/api/example", { headers: {
    "x-valet-cli-invocation": "00000000-0000-0000-0000-000000000001", "x-valet-cli-command": "status",
  } });
  expect(result.status).toBe(403);
  await vi.waitFor(async () => expect(await testApi.providers.db.select().from(externalCalls))
    .toEqual([expect.objectContaining({ outcome: "denied", errorCode })]));
});
