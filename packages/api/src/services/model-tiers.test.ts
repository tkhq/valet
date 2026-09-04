/**
 * Model size tiers (TKAI-285): tier map storage, resolution through the
 * org's tier map, and the `resolveModelSpec` tier branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { resolveModelSpec } from "./model-resolution.js";
import { getOrgTierMap, setOrgTierMap, DEFAULT_TIER_MAP, TIER_TOKENS, type TierMap } from "./model-tiers.js";
import { buildOrgCatalog, catalogValidIds } from "./model-catalog.js";

const orgId = "org-tiers";

describe("model-tiers", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  afterEach(() => vi.unstubAllEnvs());

  async function saveKey(rowId: string, apiKey: string): Promise<void> {
    await credentials.save({ type: "org", id: orgId }, `llm:${rowId}`, { type: "api_key", apiKey });
  }

  describe("getOrgTierMap", () => {
    it("returns defaults when no model_tiers is stored", async () => {
      const map = await getOrgTierMap(db, orgId);
      expect(map).toEqual(DEFAULT_TIER_MAP);
    });

    it("returns stored tiers merged over defaults", async () => {
      const custom: TierMap = {
        ...DEFAULT_TIER_MAP,
        l: ["openai/gpt-4.1"],
      };
      await setOrgTierMap(db, orgId, custom);
      const map = await getOrgTierMap(db, orgId);
      expect(map.l).toEqual(["openai/gpt-4.1"]);
      // Other tiers keep defaults.
      expect(map.xs).toEqual(DEFAULT_TIER_MAP.xs);
    });
  });

  describe("resolveModelSpec with tier tokens", () => {
    it("resolves a tier token through the tier map to a concrete spec", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const resolved = await resolveModelSpec(db, credentials, orgId, "l");
      expect(resolved).not.toBeNull();
      // Default l → anthropic/claude-opus-4-7
      expect(resolved!.model.provider).toBe("anthropic");
      expect(resolved!.model.id).toBe("claude-opus-4-7");
    });

    it("returns the tier as canonicalId, not the resolved model spec", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const resolved = await resolveModelSpec(db, credentials, orgId, "l");
      expect(resolved!.canonicalId).toBe("l");
    });

    it("is case-insensitive", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const r1 = await resolveModelSpec(db, credentials, orgId, "L");
      const r2 = await resolveModelSpec(db, credentials, orgId, "l");
      expect(r1!.canonicalId).toBe("l");
      expect(r1!.model.id).toBe(r2!.model.id);
    });

    it("handles whitespace", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const r = await resolveModelSpec(db, credentials, orgId, "  M  ");
      expect(r!.canonicalId).toBe("m");
    });

    it("returns null when no active provider for any entry in the tier", async () => {
      // Point the tier at a disabled custom provider — no fallback.
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Dead",
        baseUrl: "https://x/v1",
        models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
      });
      await updateLlmProvider(db, orgId, row.id, { enabled: false });
      const custom: TierMap = {
        ...DEFAULT_TIER_MAP,
        xs: [`${row.id}/m1`],
      };
      await setOrgTierMap(db, orgId, custom);
      const resolved = await resolveModelSpec(db, credentials, orgId, "xs");
      expect(resolved).toBeNull();
    });

    it("walks the tier list and skips inactive providers", async () => {
      // First entry is a disabled custom provider; second is Anthropic via env.
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://x/v1",
        models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
      });
      await updateLlmProvider(db, orgId, row.id, { enabled: false });
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");

      const custom: TierMap = {
        ...DEFAULT_TIER_MAP,
        m: [`${row.id}/m1`, "anthropic/claude-sonnet-4-6"],
      };
      await setOrgTierMap(db, orgId, custom);

      const resolved = await resolveModelSpec(db, credentials, orgId, "m");
      expect(resolved!.model.id).toBe("claude-sonnet-4-6");
      expect(resolved!.canonicalId).toBe("m");
    });

    it("resolve(resolve('l').canonicalId) is idempotent", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const r1 = await resolveModelSpec(db, credentials, orgId, "l");
      expect(r1).not.toBeNull();
      expect(r1!.canonicalId).toBe("l");

      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.canonicalId!);
      expect(r2).not.toBeNull();
      expect(r2!.canonicalId).toBe("l");
      expect(r2!.model.id).toBe(r1!.model.id);
      expect(r2!.model.provider).toBe(r1!.model.provider);
    });

    it("respects a custom tier map from the org", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const custom: TierMap = {
        ...DEFAULT_TIER_MAP,
        s: ["anthropic/claude-sonnet-4-6"],
      };
      await setOrgTierMap(db, orgId, custom);

      const resolved = await resolveModelSpec(db, credentials, orgId, "s");
      expect(resolved!.model.id).toBe("claude-sonnet-4-6");
      expect(resolved!.canonicalId).toBe("s");
    });

    it("falls back to no-db mode when db is undefined (no tier resolution)", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      // Without db, tier tokens fall through to the regular parse path.
      // "l" by itself parses as a bare Anthropic spec, which won't match.
      const resolved = await resolveModelSpec(undefined, credentials, orgId, "l");
      // Without db, tier branch is skipped; "l" falls to the regular
      // parse path. There's no model "l" in the Anthropic registry, so null.
      expect(resolved).toBeNull();
    });
  });

  describe("catalogValidIds includes tier tokens", () => {
    it("includes all five tier tokens in the valid id set", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const entries = await buildOrgCatalog(db, credentials, orgId);
      const validIds = catalogValidIds(entries);
      for (const tier of TIER_TOKENS) {
        expect(validIds.has(tier)).toBe(true);
      }
    });
  });
});
