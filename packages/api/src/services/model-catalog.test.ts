/**
 * Org model catalog — union of known (Anthropic/OpenAI/Google) provider
 * rows (or env-only zero-config synthesis) and custom `openai_compatible`
 * rows, in natural construction order (active entries first, then
 * inactive). See `docs/plans/2026-07-16-llm-providers.md` Task 4.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { buildOrgCatalog, catalogValidIds, thinkingLevelsFor } from "./model-catalog.js";
import { registryModels } from "./model-registry.js";
import { OPENROUTER_DEFAULT_MODEL_IDS } from "./openrouter.js";
import { setApprovedModels } from "./approved-models.js";

const orgId = "org1";

describe("model catalog", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  describe("zero-config env-only boot (today's behavior pin)", () => {
    it("with no provider rows and only ANTHROPIC_API_KEY in env, synthesizes the Anthropic registry as active", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        const anthropicIds = getModels("anthropic").map((m) => m.id);
        expect(anthropicIds.length).toBeGreaterThan(0);

        for (const id of anthropicIds) {
          const entry = entries.find((e) => e.id === `anthropic/${id}`);
          expect(entry).toBeDefined();
          expect(entry?.active).toBe(true);
          expect(entry?.providerKind).toBe("anthropic");
        }

        const validIds = catalogValidIds(entries);
        for (const id of anthropicIds) {
          expect(validIds.has(id)).toBe(true); // bare back-compat
          expect(validIds.has(`anthropic/${id}`)).toBe(true);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("with no rows and no env key, returns no active entries", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("OPENROUTER_API_KEY", "");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        expect(entries.filter((e) => e.active)).toHaveLength(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("union composition", () => {
    it("known kind, enabled, org key present → active, no secret leaked", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "anthropic", name: "Anthropic" });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "sk-ant-real-secret-value",
      });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const active = entries.filter((e) => e.active && e.providerKind === "anthropic");
      expect(active.length).toBeGreaterThan(0);
      expect(active.every((e) => e.providerId === row.id)).toBe(true);
      expect(active.every((e) => e.resolvable)).toBe(true);

      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain("sk-ant-real-secret-value");
    });

    it("known kind, enabled, no org key but env fallback present → active", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-env-stub");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        const active = entries.filter((e) => e.active && e.providerKind === "openai");
        expect(active.length).toBeGreaterThan(0);
        expect(active.every((e) => e.providerId === row.id)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("known kind, disabled → excluded from active set even with a key", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "google", name: "Google" });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "gemini-secret",
      });
      await updateLlmProvider(db, orgId, row.id, { enabled: false });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const googleEntries = entries.filter((e) => e.providerKind === "google");
      expect(googleEntries.length).toBeGreaterThan(0);
      expect(googleEntries.every((e) => e.active === false)).toBe(true);
    });

    it("custom provider with declared models + key → active entries with declared ids", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "qwen-coder", name: "Qwen Coder", contextWindow: 32000 }],
      });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "custom-secret",
      });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const entry = entries.find((e) => e.id === `${row.id}/qwen-coder`);
      expect(entry).toBeDefined();
      expect(entry?.active).toBe(true);
      expect(entry?.providerKind).toBe("openai_compatible");
      expect(entry?.providerName).toBe("Custom");
      expect(entry?.contextWindow).toBe(32000);
    });

    it("custom provider keyless → excluded from active set (no env fallback for custom)", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "qwen-coder", name: "Qwen Coder" }],
      });
      const entries = await buildOrgCatalog(db, credentials, orgId);
      const entry = entries.find((e) => e.id === `${row.id}/qwen-coder`);
      expect(entry).toBeDefined();
      expect(entry?.active).toBe(false);
      expect(entry?.resolvable).toBe(false);
    });
  });

  describe("openrouter (curated selection)", () => {
    it("zero-config: OPENROUTER_API_KEY only → the curated default set, active, nothing more", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-env-stub");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        const openrouterEntries = entries.filter((e) => e.providerKind === "openrouter");
        expect(openrouterEntries.map((e) => e.id).sort()).toEqual(
          OPENROUTER_DEFAULT_MODEL_IDS.map((id) => `openrouter/${id}`).sort(),
        );
        for (const e of openrouterEntries) {
          expect(e.active).toBe(true);
          expect(e.providerName).toBe("OpenRouter");
        }
        // Nested-slash ids must validate for defaultModel/preferences.
        const validIds = catalogValidIds(entries);
        expect(validIds.has("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("row with an edited selection → exactly that selection, registry-enriched", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openrouter",
        name: "OpenRouter",
        models: [{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }],
      });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "sk-or-secret",
      });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const openrouterEntries = entries.filter((e) => e.providerKind === "openrouter");
      expect(openrouterEntries).toHaveLength(1);
      const entry = openrouterEntries[0];
      expect(entry?.id).toBe("openrouter/moonshotai/kimi-k2.6");
      expect(entry?.active).toBe(true);
      // Pricing/context come from the registry, not the stored row entry.
      expect(typeof entry?.contextWindow).toBe("number");
      expect(entry?.pricing).toBeDefined();
    });

    it("non-registry selections (live-catalog picks) surface with stored row metadata; disabled rows are inactive", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openrouter",
        name: "OpenRouter",
        models: [
          { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
          {
            id: "moonshotai/kimi-k3",
            name: "MoonshotAI: Kimi K3",
            contextWindow: 1_048_576,
            pricing: { input: 3, output: 15 },
          },
        ],
      });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "sk-or-secret",
      });
      await updateLlmProvider(db, orgId, row.id, { enabled: false });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const openrouterEntries = entries.filter((e) => e.providerKind === "openrouter");
      expect(openrouterEntries.map((e) => e.id).sort()).toEqual([
        "openrouter/moonshotai/kimi-k2.6",
        "openrouter/moonshotai/kimi-k3",
      ]);
      const k3 = openrouterEntries.find((e) => e.id === "openrouter/moonshotai/kimi-k3");
      expect(k3?.name).toBe("MoonshotAI: Kimi K3");
      expect(k3?.contextWindow).toBe(1_048_576);
      expect(k3?.pricing).toEqual({ input: 3, output: 15 });
      for (const e of openrouterEntries) expect(e.active).toBe(false);
    });
  });

  describe("ordering", () => {
    it("keeps natural construction order — no org preference reordering", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("OPENROUTER_API_KEY", "");
      try {
        const registryOrder = registryModels("anthropic").map((m) => `anthropic/${m.id}`);
        expect(registryOrder.length).toBeGreaterThan(1);

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const active = entries.filter((e) => e.active).map((e) => e.id);

        // Active entries stay in the registry's own construction order, not
        // alphabetical and not reordered by any org preference (removed).
        expect(active).toEqual(registryOrder);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("inactive entries sort after active ones, both in construction order", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "google", name: "Google" });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "gemini-secret",
      });
      await updateLlmProvider(db, orgId, row.id, { enabled: false });

      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        const firstInactiveIdx = entries.findIndex((e) => !e.active);
        expect(firstInactiveIdx).toBeGreaterThan(-1);
        // Nothing active appears after the first inactive entry.
        expect(entries.slice(firstInactiveIdx).every((e) => !e.active)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("approved flag", () => {
    it("null approved list (unrestricted) marks every entry approved", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const entries = await buildOrgCatalog(db, credentials, orgId);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((e) => e.approved)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("a restricted approved list marks only listed entries approved, others not", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const ids = getModels("anthropic")
          .map((m) => `anthropic/${m.id}`)
          .sort();
        expect(ids.length).toBeGreaterThan(1);
        const approvedId = ids[0] as string;
        const unapprovedId = ids[ids.length - 1] as string;

        await setApprovedModels(db, orgId, [approvedId]);

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const approvedEntry = entries.find((e) => e.id === approvedId);
        const unapprovedEntry = entries.find((e) => e.id === unapprovedId);
        expect(approvedEntry?.approved).toBe(true);
        expect(unapprovedEntry?.approved).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("thinkingLevels", () => {
    // Full Model shape (no casts). pi-ai reads `thinkingLevelMap` as a
    // sparse OVERRIDE, so support must come from pi-ai's own
    // `getSupportedThinkingLevels`, not from key presence in the map
    // (TKAI-410).
    const makeModel = (reasoning: boolean, thinkingLevelMap?: ThinkingLevelMap): Model<"anthropic-messages"> => ({
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: ["text"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    });

    it.each([
      {
        name: "sparse map {xhigh, max} supports every level (claude-sonnet-5 shape)",
        map: { xhigh: "x", max: "m" } satisfies ThinkingLevelMap,
        expected: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
      {
        name: "sparse map {max} supports minimal..high plus max (claude-sonnet-4-6 shape)",
        map: { max: "m" } satisfies ThinkingLevelMap,
        expected: ["minimal", "low", "medium", "high", "max"],
      },
      {
        name: "an explicit null disables only that level (claude-fable-5 shape)",
        map: { off: null, xhigh: "x", max: "m" } satisfies ThinkingLevelMap,
        expected: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
      {
        name: "an explicit null on a base level removes it",
        map: { low: null, max: "m" } satisfies ThinkingLevelMap,
        expected: ["minimal", "medium", "high", "max"],
      },
      {
        name: "an absent map on a reasoning model supports minimal..high, not xhigh/max (claude-sonnet-4-5 shape)",
        map: undefined,
        expected: ["minimal", "low", "medium", "high"],
      },
    ])("$name", ({ map, expected }) => {
      expect(thinkingLevelsFor(makeModel(true, map))).toEqual(expected);
    });

    it("a non-reasoning model exposes thinkingLevels: undefined", () => {
      expect(thinkingLevelsFor(makeModel(false))).toBeUndefined();
      expect(thinkingLevelsFor(makeModel(false, { max: "m" }))).toBeUndefined();
    });

    it("an absent model exposes thinkingLevels: undefined", () => {
      expect(thinkingLevelsFor(undefined)).toBeUndefined();
    });

    it('catalog entries carry pi-ai\'s supported levels with "off" stripped', async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const reasoningModel = getModels("anthropic").find((m) => m.reasoning);
        expect(reasoningModel).toBeDefined();
        const expected = getSupportedThinkingLevels(reasoningModel!).filter((level) => level !== "off");
        expect(expected.length).toBeGreaterThan(0);

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const entry = entries.find((e) => e.id === `anthropic/${reasoningModel!.id}`);
        expect(entry?.thinkingLevels).toEqual(expected);
        expect(entry?.thinkingLevels).not.toContain("off");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("custom (openai_compatible) provider entries expose thinkingLevels: undefined", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "qwen-coder", name: "Qwen Coder", contextWindow: 32000 }],
      });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "custom-secret",
      });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const entry = entries.find((e) => e.id === `${row.id}/qwen-coder`);
      expect(entry).toBeDefined();
      expect(entry?.thinkingLevels).toBeUndefined();
      expect(entry?.approved).toBe(true);
    });

    it("a non-registry openrouter selection (live-catalog pick) exposes thinkingLevels: undefined", async () => {
      // The id must NOT exist in pi-ai's openrouter registry — a registry
      // hit would legitimately carry levels now that support no longer
      // requires a thinkingLevelMap.
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openrouter",
        name: "OpenRouter",
        models: [
          {
            id: "example/not-in-registry",
            name: "Example: Not In Registry",
            contextWindow: 1_048_576,
            pricing: { input: 3, output: 15 },
          },
        ],
      });
      await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
        type: "api_key",
        apiKey: "sk-or-secret",
      });

      const entries = await buildOrgCatalog(db, credentials, orgId);
      const entry = entries.find((e) => e.id === "openrouter/example/not-in-registry");
      expect(entry).toBeDefined();
      expect(entry?.thinkingLevels).toBeUndefined();
    });
  });
});
