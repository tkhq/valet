/**
 * `/api/org/model-tiers` — the org default tier field. The stub-auth harness
 * resolves the caller to `local-org`. `x-valet-test-user-id: test-member`
 * makes the caller a non-admin member.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { DEFAULT_TIER_MAP, getOrgDefaultTier, getOrgTierMap } from "../services/model-tiers.js";
import type { GetModelTiersResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function patchTiers(baseUrl: string, body: unknown, headers = HEADERS): Promise<Response> {
  return fetch(`${baseUrl}/api/org/model-tiers`, { method: "PATCH", headers, body: JSON.stringify(body) });
}

describe("/api/org/model-tiers defaultTier", () => {
  it("GET returns null when the org has no default tier", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/model-tiers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...DEFAULT_TIER_MAP, defaultTier: null });
  });

  it("an admin sets the default tier without changing the tier map, and null clears it", async () => {
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

  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await patchTiers(api.baseUrl, { defaultTier: "l" }, MEMBER_HEADERS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
    expect(await getOrgDefaultTier(api.providers.db, "local-org")).toBeNull();
  });
});
