import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { setApprovedModels } from "./approved-models.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { resolveModelFallback } from "./model-fallback.js";
import { resolveModelSpec } from "./model-resolution.js";
import { DEFAULT_TIER_MAP, setOrgTierMap } from "./model-tiers.js";

const orgId = "fallback-org";
const primary = "anthropic/claude-haiku-4-5";
const secondary = "openai/gpt-4.1";
const third = "google/gemini-2.5-pro";
let fixture: Awaited<ReturnType<typeof freshTestPgDb>>;
let credentials: PgCredentialStore;
let failedModel: ResolvedModel;

beforeEach(async () => {
  fixture = await freshTestPgDb();
  credentials = new PgCredentialStore(fixture.pgdb, deriveSecretKey("test-key"));
  await fixture.appDb.insert(orgs).values({ id: orgId, name: "Fallback", createdAt: 1 });
  vi.stubEnv("ANTHROPIC_API_KEY", "primary-key");
  const model = await resolveModelSpec(fixture.appDb, credentials, orgId, primary);
  if (!model) throw new Error("Missing fixture model");
  failedModel = model;
  await setOrgTierMap(fixture.appDb, orgId, { ...DEFAULT_TIER_MAP, m: [primary, secondary, third] });
});
afterEach(() => { vi.unstubAllEnvs(); });

const fallback = (requestedSpec = "m", attemptedProviderIds: readonly string[] = ["anthropic"]) =>
  resolveModelFallback(fixture.appDb, credentials, orgId, { requestedSpec, failedModel, attemptedProviderIds });

describe("runtime model fallback policy", () => {
  it("uses configured tier order, fresh credentials, and never revisits a failed provider", async () => {
    const row = await createLlmProvider(fixture.appDb, { orgId, kind: "openai", name: "OpenAI" });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, { type: "api_key", apiKey: "first-key" });
    vi.stubEnv("GEMINI_API_KEY", "google-key");
    expect(await fallback()).toMatchObject({ canonicalId: secondary, apiKey: "first-key" });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, { type: "api_key", apiKey: "rotated-key" });
    expect(await fallback()).toMatchObject({ canonicalId: secondary, apiKey: "rotated-key" });
    expect(await fallback("m", ["anthropic", "openai"])).toMatchObject({ canonicalId: third });
    expect(await fallback("m", ["anthropic", "openai", "google"])).toBeNull();
  });

  it("does not select an unapproved, disabled, or uncredentialed provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("GEMINI_API_KEY", "google-key");
    await setApprovedModels(fixture.appDb, orgId, [primary, third]);
    expect(await fallback()).toMatchObject({ canonicalId: third });
    const google = await createLlmProvider(fixture.appDb, { orgId, kind: "google", name: "Google" });
    await updateLlmProvider(fixture.appDb, orgId, google.id, { enabled: false });
    expect(await fallback()).toBeNull();
    await setApprovedModels(fixture.appDb, orgId, [primary, secondary, third]);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await fallback()).toBeNull();
  });

  it("uses the concrete model's matching tier and does not choose arbitrary catalog entries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    await setOrgTierMap(fixture.appDb, orgId, { ...DEFAULT_TIER_MAP, xs: [primary, secondary] });
    expect(await fallback("claude-haiku-4-5")).toMatchObject({ canonicalId: secondary });
    expect(await fallback("anthropic/not-in-any-tier")).toBeNull();
    // An explicitly selected tier keeps its own chain even if another tier could work.
    expect(await fallback("l")).toBeNull();
    await setOrgTierMap(fixture.appDb, orgId, DEFAULT_TIER_MAP);
    expect(await fallback()).toBeNull();
  });

  it("uses only this organization's configured custom providers and supported inputs", async () => {
    const row = await createLlmProvider(fixture.appDb, { orgId, kind: "openai_compatible", name: "Custom",
      baseUrl: "https://example.invalid/v1", models: [{ id: "custom-model", name: "Custom model", contextWindow: 128000 }] });
    await credentials.save({ type: "org", id: "another-org" }, `llm:${row.id}`, { type: "api_key", apiKey: "foreign-key" });
    await setOrgTierMap(fixture.appDb, orgId, { ...DEFAULT_TIER_MAP, m: [primary, `${row.id}/custom-model`] });
    expect(await fallback()).toBeNull();
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, { type: "api_key", apiKey: "own-key" });
    // A text-only endpoint cannot continue an image-capable conversation.
    expect(await fallback()).toBeNull();
    failedModel = { ...failedModel, model: { ...failedModel.model, input: ["text"] } };
    expect(await fallback()).toMatchObject({ canonicalId: `${row.id}/custom-model`, apiKey: "own-key" });
    expect(await fallback("m", ["anthropic", row.id])).toBeNull();
  });

  it("uses Astra only when configured and approved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    await setOrgTierMap(fixture.appDb, orgId, { ...DEFAULT_TIER_MAP, m: [primary, "openai/gpt-6-astra", secondary] });
    await setApprovedModels(fixture.appDb, orgId, [primary, secondary]);
    expect(await fallback()).toMatchObject({ canonicalId: secondary });
    await setApprovedModels(fixture.appDb, orgId, [primary, secondary, "openai/gpt-6-astra"]);
    expect(await fallback()).toMatchObject({ canonicalId: "openai/gpt-6-astra" });
  });
});
