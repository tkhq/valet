/**
 * Org model catalog — union of known (Anthropic/OpenAI/Google) provider
 * rows (or env-only zero-config synthesis) and custom `openai_compatible`
 * rows, in natural construction order (active entries first, then
 * inactive). See `docs/plans/2026-07-16-llm-providers.md` Task 4.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { buildOrgCatalog, catalogValidIds } from "./model-catalog.js";
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

  it("lists Claude Fable 5.1 and GPT-6 Astra", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    try {
      const entries = await buildOrgCatalog(db, credentials, orgId);
      const fable = entries.find((entry) => entry.id === "anthropic/claude-fable-5-1");
      expect(fable).toMatchObject({ name: "Claude Fable 5.1", contextWindow: 1_000_000, active: true });
      const astra = entries.find((entry) => entry.id === "openai/gpt-6-astra");
      expect(astra).toMatchObject({ name: "GPT-6 Astra", contextWindow: 272_000, active: true });
      expect(catalogValidIds(entries).has("openai/gpt-6-astra")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
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
            id: "moonshotai/not-in-baked-registry",
            name: "MoonshotAI: Not in baked registry",
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
        "openrouter/moonshotai/not-in-baked-registry",
      ]);
      const liveModel = openrouterEntries.find((e) => e.id === "openrouter/moonshotai/not-in-baked-registry");
      expect(liveModel?.name).toBe("MoonshotAI: Not in baked registry");
      expect(liveModel?.contextWindow).toBe(1_048_576);
      expect(liveModel?.pricing).toEqual({ input: 3, output: 15 });
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
    it("a registry model with a thinkingLevelMap exposes its supported levels in canonical order", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const withMap = getModels("anthropic").find(
          (m) => m.reasoning && m.thinkingLevelMap && Object.values(m.thinkingLevelMap).some((v) => v !== null),
        );
        expect(withMap).toBeDefined();
        const map = withMap!.thinkingLevelMap!;
        const canonicalOrder = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const expected = canonicalOrder.filter((level) => map[level] !== undefined && map[level] !== null);
        expect(expected.length).toBeGreaterThan(0);

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const entry = entries.find((e) => e.id === `anthropic/${withMap!.id}`);
        expect(entry?.thinkingLevels).toEqual(expected);
        // "off" is never a selectable level.
        expect(entry?.thinkingLevels).not.toContain("off");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("a reasoning model with no thinkingLevelMap exposes thinkingLevels: undefined", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      try {
        const withoutMap = getModels("anthropic").find((m) => m.reasoning && !m.thinkingLevelMap);
        expect(withoutMap).toBeDefined();

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const entry = entries.find((e) => e.id === `anthropic/${withoutMap!.id}`);
        expect(entry?.thinkingLevels).toBeUndefined();
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
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openrouter",
        name: "OpenRouter",
        models: [
          {
            id: "moonshotai/not-in-baked-registry",
            name: "MoonshotAI: Not in baked registry",
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
      const entry = entries.find((e) => e.id === "openrouter/moonshotai/not-in-baked-registry");
      expect(entry).toBeDefined();
      expect(entry?.thinkingLevels).toBeUndefined();
    });
  });
});
