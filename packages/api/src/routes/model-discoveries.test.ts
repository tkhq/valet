import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { recordModelDiscoveries } from "../services/model-discoveries.js";
import type { RegistryModel } from "../services/model-registry-parse.js";

const MODEL: RegistryModel = {
  id: "vendor/new/model",
  name: "New Model",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

function request(api: TestApi, method: "GET" | "PATCH", body?: unknown, member = false) {
  return fetch(`${api.baseUrl}/api/org/model-discoveries`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(member ? { "x-valet-test-user-id": "test-member" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/org/model-discoveries", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("allows only org admins to list and review discoveries", async () => {
    api = await bootTestApi();
    await recordModelDiscoveries(api.providers.db, "anthropic", [MODEL], 123);

    expect((await request(api, "GET", undefined, true)).status).toBe(403);
    expect((await request(api, "PATCH", {
      providerId: "anthropic", modelId: MODEL.id, state: "approved",
    }, true)).status).toBe(403);

    const response = await request(api, "GET");
    expect(response.status).toBe(200);
    expect((await response.json() as { discoveries: unknown[] }).discoveries).toEqual([
      expect.objectContaining({ providerId: "anthropic", modelId: MODEL.id, state: "pending", discoveredAt: 123 }),
    ]);
  });

  it("validates reviews and supports model ids containing slashes", async () => {
    api = await bootTestApi();
    await recordModelDiscoveries(api.providers.db, "anthropic", [MODEL], 123);

    expect((await request(api, "PATCH", { state: "approved" })).status).toBe(400);
    expect((await request(api, "PATCH", {
      providerId: "anthropic", modelId: "missing/model", state: "approved",
    })).status).toBe(404);

    for (const state of ["approved", "rejected"] as const) {
      const response = await request(api, "PATCH", {
        providerId: "anthropic", modelId: MODEL.id, state,
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { discovery: { state: string } }).discovery.state).toBe(state);
    }
  });
});
