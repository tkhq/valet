/**
 * Provider failover candidates (TKAI-326) — tier classification and the
 * candidate walk over org preferences + static per-kind defaults. All
 * provider env keys are stubbed empty so ambient dev-shell keys cannot
 * change which catalog entries are active (same trap as
 * host.model-resolution.test.ts).
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { setOrgModelPreferences } from "./org.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { classifyModelTier, failoverCandidates, TIER_DEFAULTS } from "./model-failover.js";
import { buildOrgCatalog } from "./model-catalog.js";

const orgId = "org1";

describe("classifyModelTier", () => {
  it("classifies family names into tiers", () => {
    expect(classifyModelTier("claude-haiku-4-5")).toBe("S");
    expect(classifyModelTier("gpt-4.1-mini")).toBe("S");
    expect(classifyModelTier("gpt-5-nano")).toBe("S");
    expect(classifyModelTier("gemini-2.5-flash-lite")).toBe("S");
    expect(classifyModelTier("claude-sonnet-4-6")).toBe("M");
    expect(classifyModelTier("gpt-4.1")).toBe("M");
    expect(classifyModelTier("gemini-2.5-flash")).toBe("M");
    expect(classifyModelTier("o3")).toBe("M");
    expect(classifyModelTier("claude-opus-4-8")).toBe("L");
    expect(classifyModelTier("gpt-5-pro")).toBe("L");
    expect(classifyModelTier("gemini-2.5-pro")).toBe("L");
    expect(classifyModelTier("o1")).toBe("L");
  });

  it("lets a known price override broad family words", () => {
    // "gpt"/"gemini" span three orders of magnitude of price — the price
    // band must win over the vendor word (this module's own openai L
    // default, gpt-5.5, would otherwise classify M).
    expect(classifyModelTier("gpt-5.5", 30)).toBe("L");
    expect(classifyModelTier("gpt-oss-20b", 0.2)).toBe("S");
    expect(classifyModelTier("gemini-2.5-flash", 2.5)).toBe("M");
  });

  it("falls back to output-price bands, then M, for unknown ids", () => {
    expect(classifyModelTier("deepseek-v4-cheap", 0.5)).toBe("S");
    expect(classifyModelTier("deepseek-v4", 8)).toBe("M");
    expect(classifyModelTier("deepseek-v4-max", 60)).toBe("L");
    expect(classifyModelTier("mystery-model")).toBe("M");
  });
});

describe("failoverCandidates", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    // Ambient provider keys would activate catalog entries this test did
    // not configure — scrub them all.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function addKeyedProvider(kind: "anthropic" | "openai" | "google"): Promise<string> {
    const row = await createLlmProvider(db, { orgId, kind, name: kind });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
      type: "api_key",
      apiKey: `sk-${kind}-test`,
    });
    return row.id;
  }

  it("returns same-tier defaults on other keyed providers, one per provider", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("openai");
    await addKeyedProvider("google");

    const candidates = await failoverCandidates(db, credentials, orgId, "anthropic/claude-opus-4-8");
    expect(candidates).toEqual(["openai/gpt-5.5", "google/gemini-3.1-pro-preview"]);
  });

  it("prefers a same-tier org preference over the static defaults", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("openai");
    await addKeyedProvider("google");
    await setOrgModelPreferences(db, orgId, ["google/gemini-2.5-pro"]);

    const candidates = await failoverCandidates(db, credentials, orgId, "anthropic/claude-opus-4-8");
    expect(candidates[0]).toBe("google/gemini-2.5-pro");
    expect(candidates).toContain("openai/gpt-5.5");
  });

  it("skips preferences on the failing provider and off-tier preferences", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("google");
    await setOrgModelPreferences(db, orgId, [
      "anthropic/claude-sonnet-4-6", // failing provider — never a candidate
      "google/gemini-flash-lite-latest", // S, not the failing M tier
    ]);

    const candidates = await failoverCandidates(db, credentials, orgId, "anthropic/claude-sonnet-4-6");
    expect(candidates).toEqual(["google/gemini-flash-latest"]);
  });

  it("matches the failing model's tier (M fails over to M)", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("openai");

    const candidates = await failoverCandidates(db, credentials, orgId, "openai/gpt-4.1");
    expect(candidates).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("returns nothing when no other provider is usable", async () => {
    await addKeyedProvider("anthropic");
    expect(await failoverCandidates(db, credentials, orgId, "anthropic/claude-opus-4-8")).toEqual([]);
  });

  it("excludes disabled providers", async () => {
    await addKeyedProvider("anthropic");
    const openaiId = await addKeyedProvider("openai");
    await updateLlmProvider(db, orgId, openaiId, { enabled: false });

    expect(await failoverCandidates(db, credentials, orgId, "anthropic/claude-opus-4-8")).toEqual([]);
  });

  it("treats a bare failing spec as Anthropic", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("openai");

    const candidates = await failoverCandidates(db, credentials, orgId, "claude-haiku-4-5");
    expect(candidates).toEqual(["openai/gpt-5.4-mini"]);
  });

  it("returns nothing without an app db", async () => {
    expect(await failoverCandidates(undefined, credentials, orgId, "anthropic/claude-opus-4-8")).toEqual([]);
  });

  it("excludes the failing model's upstream VENDOR, not just its provider row", async () => {
    // A custom openai_compatible proxy serving an OpenAI model fails: the
    // direct openai provider fronts the same melting-down vendor and must
    // not be a candidate.
    const proxy = await createLlmProvider(db, {
      orgId,
      kind: "openai_compatible",
      name: "myproxy",
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-5.4", name: "GPT 5.4 via proxy" }],
    });
    await credentials.save({ type: "org", id: orgId }, `llm:${proxy.id}`, {
      type: "api_key",
      apiKey: "sk-proxy-test",
    });
    await addKeyedProvider("openai");
    await addKeyedProvider("anthropic");

    const candidates = await failoverCandidates(db, credentials, orgId, `${proxy.id}/gpt-5.4`);
    expect(candidates).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("excludes an openrouter preference that fronts the failing vendor", async () => {
    const openrouter = await createLlmProvider(db, {
      orgId,
      kind: "openrouter",
      name: "OpenRouter",
      models: [{ id: "anthropic/claude-sonnet-4-6", name: "Sonnet via OpenRouter" }],
    });
    await credentials.save({ type: "org", id: orgId }, `llm:${openrouter.id}`, {
      type: "api_key",
      apiKey: "sk-or-test",
    });
    await addKeyedProvider("anthropic");
    await setOrgModelPreferences(db, orgId, ["openrouter/anthropic/claude-sonnet-4-6"]);

    // Anthropic (direct) is failing; the OpenRouter selection still runs
    // on Anthropic's backend, so no candidate remains.
    expect(await failoverCandidates(db, credentials, orgId, "anthropic/claude-sonnet-4-6")).toEqual(
      [],
    );
  });

  it("TIER_DEFAULTS ids are catalog-resolvable and classify as their declared tier", async () => {
    await addKeyedProvider("anthropic");
    await addKeyedProvider("openai");
    await addKeyedProvider("google");
    const catalog = await buildOrgCatalog(db, credentials, orgId);
    const byId = new Map(catalog.filter((e) => e.active).map((e) => [e.id, e]));

    for (const [kind, tiers] of Object.entries(TIER_DEFAULTS)) {
      for (const [tier, ids] of Object.entries(tiers)) {
        for (const id of ids) {
          const entry = byId.get(`${kind}/${id}`);
          // A stale id would silently shrink failover coverage — prune it.
          expect(entry, `${kind}/${id} missing from the registry catalog`).toBeDefined();
          expect(
            classifyModelTier(id, entry?.pricing?.output),
            `${kind}/${id} does not classify as its declared tier`,
          ).toBe(tier);
        }
      }
    }
  });
});
