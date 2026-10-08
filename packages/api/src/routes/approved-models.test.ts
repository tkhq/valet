import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { getOrgTierMap, setOrgTierMap, type TierMap } from "../services/model-tiers.js";

import { setApprovedModels } from "../services/approved-models.js";

const TIER_MAP: TierMap = {
  xs: ["anthropic/claude-haiku-4-5"],
  s: ["anthropic/claude-haiku-4-5"],
  m: ["anthropic/claude-sonnet-4-6"],
  l: ["anthropic/claude-opus-4-7"],
  xl: ["anthropic/claude-opus-4-7"],
};

describe("PUT /api/org/approved-models", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    vi.unstubAllEnvs();
  });

  it("rejects a list that removes a configured tier target", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    api = await bootTestApi();
    await setOrgTierMap(api.providers.db, "local-org", TIER_MAP);

    const response = await fetch(`${api.baseUrl}/api/org/approved-models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved: [
          "anthropic/claude-haiku-4-5",
          "anthropic/claude-opus-4-7",
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Model "anthropic/claude-sonnet-4-6" is still used by tier "m". Change the model tier first.',
    );
  });

  it.each([false, true])("allows upgrading retired Sol approval (retain old: %s)", async (retainOld) => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    api = await bootTestApi();
    const previous = { ...TIER_MAP, l: ["openai/gpt-5.6-sol"] };
    await setOrgTierMap(api.providers.db, "local-org", previous);
    await setApprovedModels(api.providers.db, "local-org", [...new Set(Object.values(previous).flat())]);
    const approved = [...new Set(Object.values({ ...previous, l: ["openai/gpt-6.1-sol"] }).flat())];
    if (retainOld) approved.push("openai/gpt-5.6-sol");
    const response = await fetch(`${api.baseUrl}/api/org/approved-models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    expect(response.status).toBe(200);
    expect((await getOrgTierMap(api.providers.db, "local-org")).l).toEqual(["openai/gpt-6.1-sol"]);
  });

  it("allows null to clear the restriction", async () => {
    api = await bootTestApi();
    await setOrgTierMap(api.providers.db, "local-org", TIER_MAP);

    const response = await fetch(`${api.baseUrl}/api/org/approved-models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: null }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approved: null });
  });
});
