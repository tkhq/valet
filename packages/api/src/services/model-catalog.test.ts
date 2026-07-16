/**
 * Org model catalog — union of known (Anthropic/OpenAI/Google) provider
 * rows (or env-only zero-config synthesis) and custom `openai_compatible`
 * rows, ordered by org `modelPreferences` then alphabetically. See
 * `docs/plans/2026-07-16-llm-providers.md` Task 4.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { getModels } from "@mariozechner/pi-ai";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { setOrgModelPreferences } from "./org.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { buildOrgCatalog, catalogValidIds } from "./model-catalog.js";

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

  describe("ordering", () => {
    it("orders modelPreferences first (in order), then remaining actives alphabetically", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
      vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      try {
        const models = getModels("anthropic")
          .map((m) => m.id)
          .sort();
        expect(models.length).toBeGreaterThan(1);
        const last = models[models.length - 1] as string;
        const first = models[0] as string;

        await setOrgModelPreferences(db, orgId, [`anthropic/${last}`]);

        const entries = await buildOrgCatalog(db, credentials, orgId);
        const active = entries.filter((e) => e.active);
        expect(active[0]?.id).toBe(`anthropic/${last}`);

        // Remaining actives (excluding the preferred one) come alphabetically.
        const rest = active.slice(1).map((e) => e.id);
        const restIds = models
          .filter((m) => m !== last)
          .map((m) => `anthropic/${m}`)
          .sort();
        expect(rest).toEqual(restIds);
        expect(rest[0]).toBe(`anthropic/${first}`);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
