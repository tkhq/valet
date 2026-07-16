/**
 * `/api/models` — the org model catalog (split-settings design, decision 9,
 * superseded by the llm-providers design doc). See
 * `services/model-catalog.test.ts` for the catalog's own composition/
 * ordering coverage; this file only exercises the route's active-only
 * filtering + auth gate.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListModelsResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/models", () => {
  it("zero-config: returns the namespaced Anthropic registry as ModelInfo, no secrets, active only", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      const res = await fetch(`${api.baseUrl}/api/models`);
      expect(res.status).toBe(200);
      const { models } = (await res.json()) as ListModelsResponse;

      expect(models.length).toBeGreaterThan(0);
      expect(models.map((m) => m.id)).toContain("anthropic/claude-haiku-4-5");

      for (const model of models) {
        expect(typeof model.id).toBe("string");
        expect(typeof model.name).toBe("string");
        expect(typeof model.providerId).toBe("string");
        expect(typeof model.providerKind).toBe("string");
        expect(typeof model.providerName).toBe("string");
        expect(model.active).toBe(true);
      }

      const anthropicModel = models.find((m) => m.id === "anthropic/claude-haiku-4-5");
      expect(anthropicModel).toMatchObject({ providerKind: "anthropic", active: true });
      expect(JSON.stringify(models)).not.toContain("sk-ant-env-stub");
    } finally {
      vi.unstubAllEnvs();
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
