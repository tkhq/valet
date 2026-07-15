/**
 * `/api/models` — pi-ai's static Anthropic registry (split-settings design,
 * decision 9). No provider API call; just a read of the bundled catalog.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListModelsResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/models", () => {
  it("returns a non-empty list of Anthropic models, each matching ModelInfo", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/models`);
    expect(res.status).toBe(200);
    const { models } = (await res.json()) as ListModelsResponse;

    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain("claude-haiku-4-5");

    for (const model of models) {
      expect(typeof model.id).toBe("string");
      expect(typeof model.name).toBe("string");
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.reasoning).toBe("boolean");
    }
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/models`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});
