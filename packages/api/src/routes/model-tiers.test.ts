/**
 * `/api/org/model-tiers` — the org default tier field. The stub-auth harness
 * resolves the caller to `local-org`. `x-valet-test-user-id: test-member`
 * makes the caller a non-admin member. The unit project scrubs provider env
 * keys before each test, so a test that saves a tier stubs a key first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createLlmProvider, updateLlmProvider } from "../services/llm-providers.js";
import {
  DEFAULT_TIER_MAP,
  getOrgDefaultTier,
  getOrgTierMap,
  setOrgDefaultTier,
  setOrgTierMap,
} from "../services/model-tiers.js";
import { OPENROUTER_DEFAULT_MODEL_IDS } from "../services/openrouter.js";
import type { GetModelTiersResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

/** Points tier "l" at the model of an OpenAI provider that is then disabled,
 * so no active provider serves "l". The other tiers keep their defaults. */
async function disableLargeTier(test: TestApi): Promise<void> {
  const { db } = test.providers;
  const row = await createLlmProvider(db, { orgId: "local-org", kind: "openai", name: "OpenAI" });
  await setOrgTierMap(db, "local-org", { ...DEFAULT_TIER_MAP, l: ["openai/gpt-4.1"] });
  await updateLlmProvider(db, "local-org", row.id, { enabled: false });
}

async function patchTiers(baseUrl: string, body: unknown, headers = HEADERS): Promise<Response> {
  return fetch(`${baseUrl}/api/org/model-tiers`, { method: "PATCH", headers, body: JSON.stringify(body) });
}

describe("/api/org/model-tiers defaultTier", () => {
  it("GET returns null when the org has no default tier", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/model-tiers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...DEFAULT_TIER_MAP, defaultTier: null, defaultTierResolvable: false });
  });

  it("GET reports whether a provider with a key serves the saved default tier", async () => {
    api = await bootTestApi();
    // Saved directly: the PATCH refuses a tier with no key, but a key can go
    // away after the save.
    await setOrgDefaultTier(api.providers.db, "local-org", "m");

    const keyless = (await (await fetch(`${api.baseUrl}/api/org/model-tiers`)).json()) as GetModelTiersResponse;
    expect(keyless.defaultTier).toBe("m");
    expect(keyless.defaultTierResolvable).toBe(false);

    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const keyed = (await (await fetch(`${api.baseUrl}/api/org/model-tiers`)).json()) as GetModelTiersResponse;
    expect(keyed.defaultTierResolvable).toBe(true);
  });

  it("an admin sets the default tier without changing the tier map, and null clears it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const { db } = api.providers;

    const set = await patchTiers(api.baseUrl, { defaultTier: "m" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as GetModelTiersResponse).defaultTier).toBe("m");
    expect(await getOrgDefaultTier(db, "local-org")).toBe("m");
    expect(await getOrgTierMap(db, "local-org")).toEqual(DEFAULT_TIER_MAP);

    const read = await fetch(`${api.baseUrl}/api/org/model-tiers`);
    expect(((await read.json()) as GetModelTiersResponse).defaultTier).toBe("m");

    const clear = await patchTiers(api.baseUrl, { defaultTier: null });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as GetModelTiersResponse).defaultTier).toBeNull();
    expect(await getOrgDefaultTier(db, "local-org")).toBeNull();
  });

  it.each(["opus", "anthropic/claude-opus-4-7", "M", 3])("rejects %s, which is not a tier token", async (value) => {
    api = await bootTestApi();
    const res = await patchTiers(api.baseUrl, { defaultTier: value });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "defaultTier must be one of xs, s, m, l, xl, or null to clear it." });
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });

  it("refuses a tier that no provider with a key serves, and names the fix", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    await disableLargeTier(api);

    const res = await patchTiers(api.baseUrl, { defaultTier: "l" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'No provider this organization holds a key for serves tier "l". ' +
        "Point the tier's first target at a provider with a key in Settings → Organization → Models, " +
        "or choose another default tier.",
    });
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });

  it("checks the default tier against the tier map the same request writes", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    await disableLargeTier(api);

    const res = await patchTiers(api.baseUrl, { l: ["anthropic/claude-opus-4-7"], defaultTier: "l" });
    expect(res.status).toBe(200);
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBe("l");
    expect((await getOrgTierMap(api.providers.db, "local-org")).l).toEqual(["anthropic/claude-opus-4-7"]);
  });

  it.each([
    [{ m: ["m"], defaultTier: "m" }, 'Tier "m" cannot target the tier token "m".'],
    [{ l: ["xl"], xl: ["l"] }, 'Tier "l" cannot target the tier token "xl".'],
  ])("refuses a tier token as a tier target: %j", async (body, lead) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();

    const res = await patchTiers(api.baseUrl, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `${lead} Pick a model from the model list (GET /api/models) for each target.`,
    });
    expect(await getOrgTierMap(api.providers.db, "local-org")).toEqual(DEFAULT_TIER_MAP);
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });

  it("lets the Models page replace a tier token that the tier already held", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    api = await bootTestApi();
    const { db } = api.providers;
    // Saved directly: a map saved before the PATCH refused tier tokens.
    await setOrgTierMap(db, "local-org", { ...DEFAULT_TIER_MAP, m: ["s"] });
    const model = "anthropic/claude-sonnet-4-6";

    // The page sends the full list: first it adds a model, then it removes "s".
    expect((await patchTiers(api.baseUrl, { m: ["s", model] })).status).toBe(200);
    expect((await getOrgTierMap(db, "local-org")).m).toEqual(["s", model]);
    expect((await patchTiers(api.baseUrl, { m: [model] })).status).toBe(200);
    expect((await getOrgTierMap(db, "local-org")).m).toEqual([model]);

    // The tier no longer holds "s", so the PATCH refuses it again.
    expect((await patchTiers(api.baseUrl, { m: ["s", model] })).status).toBe(400);
  });

  it("refuses a tier edit that leaves the saved default tier with no provider that has a key", async () => {
    // A zero-config OpenRouter key puts OpenRouter models in the catalog,
    // so the catalog check accepts the target. The tier walk does not count
    // OpenRouter without a provider row, so no provider would serve "m".
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    api = await bootTestApi();
    expect((await patchTiers(api.baseUrl, { defaultTier: "m" })).status).toBe(200);

    const target = `openrouter/${OPENROUTER_DEFAULT_MODEL_IDS[0]}`;
    const res = await patchTiers(api.baseUrl, { m: [target] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'This change leaves tier "m", the organization default tier, with no provider this ' +
        "organization holds a key for. Put a target whose provider has a key first in the tier, " +
        "or choose another default tier before you change it.",
    });
    expect((await getOrgTierMap(api.providers.db, "local-org")).m).toEqual(DEFAULT_TIER_MAP.m);
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBe("m");

    // An edit to another tier does not touch the default, so it saves.
    expect((await patchTiers(api.baseUrl, { l: [target] })).status).toBe(200);
    // Clearing the default in the same request lets the edit through.
    const cleared = await patchTiers(api.baseUrl, { m: [target], defaultTier: null });
    expect(cleared.status).toBe(200);
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });

  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await patchTiers(api.baseUrl, { defaultTier: "l" }, MEMBER_HEADERS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });
});
