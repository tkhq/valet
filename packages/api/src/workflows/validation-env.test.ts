/**
 * Save-time model validation for workflow definitions. `isKnownModelSpec`
 * covers the no-org fallback; the `buildOrgValidateEnvironment` suite covers
 * the org-aware set that full saves (`POST`/`PUT /api/workflows`,
 * `save_workflow`, `patch_workflow`) validate against.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { setApprovedModels } from "../services/approved-models.js";
import { DEFAULT_TIER_MAP, setOrgTierMap } from "../services/model-tiers.js";
import {
  buildOrgValidateEnvironment,
  buildValidateEnvironment,
  isKnownModelSpec,
  type OrgValidateDeps,
} from "./validation-env.js";

describe("workflow model validation", () => {
  it.each(["openai/gpt-6-astra", "gpt-6-astra"])("accepts the supplemental model %s", (spec) => {
    expect(isKnownModelSpec(spec)).toBe(true);
  });

  it("still rejects unknown models and providers", () => {
    expect(isKnownModelSpec("openai/unknown-model")).toBe(false);
    expect(isKnownModelSpec("unknown-provider/gpt-6-astra")).toBe(false);
  });
});

const orgId = "org-validation-env";

describe("buildOrgValidateEnvironment", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  afterEach(() => vi.unstubAllEnvs());

  async function orgEnv(): Promise<(spec: string) => boolean | string> {
    const deps: OrgValidateDeps = { db, credentials };
    const env = await buildOrgValidateEnvironment(deps, orgId);
    const hook = env.isKnownModel;
    expect(hook).toBeDefined();
    return hook!;
  }

  it("accepts an active, approved model in both spellings", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    const isKnownModel = await orgEnv();
    expect(isKnownModel("anthropic/claude-haiku-4-5")).toBe(true);
    expect(isKnownModel("claude-haiku-4-5")).toBe(true);
  });

  it("rejects a model whose provider row is disabled", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    await createLlmProvider(db, { orgId, kind: "anthropic", name: "Anthropic", enabled: false });
    const isKnownModel = await orgEnv();
    expect(isKnownModel("anthropic/claude-haiku-4-5")).not.toBe(true);
  });

  it("rejects an active model the org did not approve", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    await setApprovedModels(db, orgId, ["anthropic/claude-opus-4-7"]);
    const isKnownModel = await orgEnv();
    expect(isKnownModel("anthropic/claude-opus-4-7")).toBe(true);
    expect(isKnownModel("anthropic/claude-haiku-4-5")).not.toBe(true);
  });

  it("names the corrective action when it rejects a model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    await setApprovedModels(db, orgId, ["anthropic/claude-opus-4-7"]);
    const isKnownModel = await orgEnv();
    expect(isKnownModel("anthropic/claude-haiku-4-5")).toEqual(expect.stringContaining("Settings > Models"));
  });

  it("keeps a bare OpenAI id valid while its provider is active and approved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const isKnownModel = await orgEnv();
    expect(isKnownModel("openai/gpt-6-astra")).toBe(true);
    expect(isKnownModel("gpt-6-astra")).toBe(true);
  });

  it("rejects a bare OpenAI id once the org stops approving it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    await setApprovedModels(db, orgId, ["openai/gpt-5.5"]);
    const isKnownModel = await orgEnv();
    expect(isKnownModel("gpt-6-astra")).not.toBe(true);
  });

  it("keeps a bare Google id valid while Google is active and approved", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-google");
    const isKnownModel = await orgEnv();
    expect(isKnownModel("google/gemini-2.5-pro")).toBe(true);
    expect(isKnownModel("gemini-2.5-pro")).toBe(true);
  });

  it("accepts an OpenRouter id the row never curated, because the run resolves it", async () => {
    // The catalog lists only the row's selection (an empty one here), but
    // `resolveModelSpec` resolves any id in the OpenRouter registry while the
    // row is enabled and keyed. Definitions naming those ids must keep saving.
    const row = await createLlmProvider(db, { orgId, kind: "openrouter", name: "OpenRouter", models: [] });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
      type: "api_key",
      apiKey: "org-openrouter",
    });
    const isKnownModel = await orgEnv();
    expect(isKnownModel("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
  });

  it("rejects an OpenRouter id when the org has no OpenRouter provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    const isKnownModel = await orgEnv();
    expect(isKnownModel("openrouter/deepseek/deepseek-v4-pro")).not.toBe(true);
  });

  it("rejects an OpenRouter registry id the org did not approve", async () => {
    const row = await createLlmProvider(db, { orgId, kind: "openrouter", name: "OpenRouter", models: [] });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, {
      type: "api_key",
      apiKey: "org-openrouter",
    });
    await setApprovedModels(db, orgId, ["openrouter/moonshotai/kimi-k2.6"]);
    const isKnownModel = await orgEnv();
    expect(isKnownModel("openrouter/moonshotai/kimi-k2.6")).toBe(true);
    expect(isKnownModel("openrouter/deepseek/deepseek-v4-pro")).not.toBe(true);
  });

  it("accepts a size tier whose target provider is active", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    const isKnownModel = await orgEnv();
    for (const tier of ["xs", "s", "m", "l", "xl"]) expect(isKnownModel(tier)).toBe(true);
    expect(isKnownModel("M")).toBe(true);
  });

  it("rejects a size tier that no provider can serve", async () => {
    // The default tier map points at Anthropic; only OpenAI has a key here,
    // so a preset that saves the "m" tier would fail at run time.
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const isKnownModel = await orgEnv();
    expect(isKnownModel("m")).toEqual(expect.stringContaining("Point the tier's first target"));
  });

  it("accepts a size tier the org re-pointed at a provider it can use", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    await setOrgTierMap(db, orgId, { ...DEFAULT_TIER_MAP, m: ["openai/gpt-6-astra"] });
    const isKnownModel = await orgEnv();
    expect(isKnownModel("m")).toBe(true);
    expect(isKnownModel("l")).not.toBe(true);
  });

  it("falls back to the bundled ids when no org set is supplied", () => {
    const env = buildValidateEnvironment();
    expect(env.isKnownModel?.("claude-haiku-4-5")).toBe(true);
    expect(env.isKnownModel?.("gpt-6-astra")).toBe(true);
    expect(env.isKnownModel?.("m")).toBe(true);
  });
});
