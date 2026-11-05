import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { llmProxyRequests } from "../schema/index.js";
import { repriceProxyCalls } from "./reprice.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); });

it("previews and applies scoped historical cache corrections idempotently", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  for (const [id, orgId, createdAt, model] of [
    ["affected", "local-org", 100, "gpt-5"],
    ["other-org", "other", 100, "gpt-5"],
    ["newer", "local-org", 300, "gpt-5"],
    ["unknown", "local-org", 100, "unknown-model"],
  ] as const) {
    await db.insert(llmProxyRequests).values({
      id, orgId, createdAt, model, userId: "local-user", apiKeyId: "k",
      providerKind: "openai", endpoint: "/v1/responses", stream: false, statusCode: 200,
      requestBody: JSON.stringify({ model }), inputTokens: 1_000_000, outputTokens: 1000,
      cacheReadTokens: 900_000, totalTokens: 1_001_000, costUsd: 1.3725,
    });
  }
  const opts = { orgId: "local-org", beforeMs: 200, apply: false };
  const preview = await repriceProxyCalls(db, opts);
  expect(preview).toMatchObject({ changed: 1, skipped: 1 });
  expect(preview.oldCostUsd).toBeCloseTo(1.3725);
  expect(preview.newCostUsd).toBeCloseTo(0.2475);
  expect((await db.select().from(llmProxyRequests)).every((r) => r.costUsd === 1.3725)).toBe(true);
  expect(await repriceProxyCalls(db, { ...opts, apply: true })).toEqual(preview);
  const rows = await db.select().from(llmProxyRequests);
  expect(rows.find((r) => r.id === "affected")?.costUsd).toBeCloseTo(0.2475);
  expect(rows.filter((r) => r.id !== "affected").every((r) => r.costUsd === 1.3725)).toBe(true);
  expect((await repriceProxyCalls(db, { ...opts, apply: true })).changed).toBe(0);
});
