/**
 * Catalog-aware model resolution (llm-providers plan Task 5): the api-side
 * `resolveModel` bridge (`services/model-resolution.ts`) and its wiring into
 * every `EngineHost` session build.
 *
 * The standalone-resolver suite pins the contract facts carried forward from
 * Task 1's adversarial review — canonical-id round-trip per kind, org key over
 * env, custom synthesis exact-shape, no env fallback for custom providers,
 * disabled/deleted/inactive throws, and per-turn key freshness (no caching).
 * The host suite pins the new-session precedence matrix and restore-no-clobber
 * with a namespaced persisted model.
 *
 * Env note: the "unit" vitest project scrubs provider env keys before every
 * test (vitest.setup.ts), so `vi.stubEnv` sits on top of a clean base.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs, teams, users, type LlmProviderModel } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "../services/llm-providers.js";
import { setOrgModelPreferences } from "../services/org.js";
import { createTeam } from "../services/teams.js";
import { NoCredentialsError } from "@valet/engine";
import { resolveModelSpec } from "../services/model-resolution.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";

const orgId = "org-res";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_MODEL = "gpt-4.1";
const GOOGLE_MODEL = "gemini-2.5-pro";

describe("resolveModelSpec (catalog-aware bridge)", () => {
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

  describe("namespace parsing + bare back-compat", () => {
    it("bare id resolves to Anthropic and keeps its bare canonical id", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const resolved = await resolveModelSpec(db, credentials, orgId, ANTHROPIC_MODEL);
      expect(resolved?.model.provider).toBe("anthropic");
      expect(resolved?.model.id).toBe(ANTHROPIC_MODEL); // bare stays bare
      expect(resolved?.apiKey).toBe("env-anthropic");
    });

    it("namespaced anthropic id keeps its namespace in the canonical id (wire id stays bare)", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const resolved = await resolveModelSpec(db, credentials, orgId, `anthropic/${ANTHROPIC_MODEL}`);
      expect(resolved?.model.provider).toBe("anthropic");
      // model.id is the WIRE id — what pi-ai sends to the provider verbatim.
      expect(resolved?.model.id).toBe(ANTHROPIC_MODEL);
      expect(resolved?.canonicalId).toBe(`anthropic/${ANTHROPIC_MODEL}`);
    });

    it("unknown model on a known kind returns null (setModel → 'unknown model id')", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      expect(await resolveModelSpec(db, credentials, orgId, "anthropic/not-a-real-model")).toBeNull();
    });
  });

  describe("org key over env, per known kind", () => {
    it("anthropic: org credential wins over ANTHROPIC_API_KEY", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const row = await createLlmProvider(db, { orgId, kind: "anthropic", name: "Anthropic" });
      await saveKey(row.id, "org-anthropic");
      const resolved = await resolveModelSpec(db, credentials, orgId, `anthropic/${ANTHROPIC_MODEL}`);
      expect(resolved?.apiKey).toBe("org-anthropic");
    });

    it("openai: org credential wins over OPENAI_API_KEY", async () => {
      vi.stubEnv("OPENAI_API_KEY", "env-openai");
      const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      await saveKey(row.id, "org-openai");
      const resolved = await resolveModelSpec(db, credentials, orgId, `openai/${OPENAI_MODEL}`);
      expect(resolved?.model.provider).toBe("openai");
      expect(resolved?.apiKey).toBe("org-openai");
    });

    it("google: org credential wins over GEMINI_API_KEY", async () => {
      vi.stubEnv("GEMINI_API_KEY", "env-google");
      const row = await createLlmProvider(db, { orgId, kind: "google", name: "Google" });
      await saveKey(row.id, "org-google");
      const resolved = await resolveModelSpec(db, credentials, orgId, `google/${GOOGLE_MODEL}`);
      expect(resolved?.model.provider).toBe("google");
      expect(resolved?.apiKey).toBe("org-google");
    });

    it("known kind with a row but no org key falls back to env", async () => {
      vi.stubEnv("OPENAI_API_KEY", "env-openai");
      await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      const resolved = await resolveModelSpec(db, credentials, orgId, `openai/${OPENAI_MODEL}`);
      expect(resolved?.apiKey).toBe("env-openai");
    });
  });

  describe("no key ANYWHERE → NoCredentialsError with the resolved model attached", () => {
    it("known kind with a row, no org key, no env key", async () => {
      // vitest.setup.ts scrubbed the provider env vars; no key is saved.
      await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      const err = await resolveModelSpec(db, credentials, orgId, `openai/${OPENAI_MODEL}`).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NoCredentialsError);
      const cred = err as NoCredentialsError;
      expect(cred.message).toMatch(/no usable API key for model "openai\/gpt-4\.1"/);
      // The model resolved fine — setModel-style validation accepts it.
      expect(cred.model?.id).toBe(`openai/${OPENAI_MODEL}`);
    });

    it("zero-config known namespace with no env key", async () => {
      const err = await resolveModelSpec(db, credentials, orgId, ANTHROPIC_MODEL).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NoCredentialsError);
      expect((err as NoCredentialsError).model?.id).toBe(ANTHROPIC_MODEL);
    });

    it("an EMPTY-STRING stored org key behaves as missing (known kind, no env key)", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      await saveKey(row.id, "   ");
      const err = await resolveModelSpec(db, credentials, orgId, `openai/${OPENAI_MODEL}`).then(
        () => undefined,
        (e: unknown) => e,
      );
      // Blank ≡ absent: NoCredentialsError, never "" sent to the provider.
      expect(err).toBeInstanceOf(NoCredentialsError);
      expect((err as NoCredentialsError).model?.id).toBe(`openai/${OPENAI_MODEL}`);
    });
  });

  describe("custom (openai_compatible) provider", () => {
    async function makeCustom(
      models: LlmProviderModel[] = [{ id: "qwen-coder", name: "Qwen Coder", contextWindow: 32_000, pricing: { input: 1, output: 2 } }],
    ) {
      return createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Together",
        baseUrl: "https://api.together.xyz/v1",
        models,
      });
    }

    it("synthesizes an openai-completions Model with the exact declared shape", async () => {
      const row = await makeCustom();
      await saveKey(row.id, "org-together");
      const resolved = await resolveModelSpec(db, credentials, orgId, `${row.id}/qwen-coder`);
      expect(resolved).not.toBeNull();
      const m = resolved!.model;
      expect(m.id).toBe("qwen-coder"); // WIRE id — what the upstream endpoint expects
      expect(resolved!.canonicalId).toBe(`${row.id}/qwen-coder`); // spec round-trips via canonicalId
      expect(m.name).toBe("Qwen Coder");
      expect(m.api).toBe("openai-completions");
      expect(m.provider).toBe(row.id);
      expect(m.baseUrl).toBe("https://api.together.xyz/v1");
      expect(m.reasoning).toBe(false);
      expect(m.input).toEqual(["text"]);
      expect(m.contextWindow).toBe(32_000);
      expect(m.maxTokens).toBe(8192);
      expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
      expect(resolved!.apiKey).toBe("org-together");
    });

    it("defaults contextWindow to 128000 and cost to zeros when the entry omits them", async () => {
      const row = await makeCustom([{ id: "m1", name: "M1" }]);
      await saveKey(row.id, "k");
      const resolved = await resolveModelSpec(db, credentials, orgId, `${row.id}/m1`);
      expect(resolved?.model.contextWindow).toBe(128_000);
      expect(resolved?.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("NO env fallback: missing org key throws NoCredentialsError 'provider {name} has no API key'", async () => {
      // Even a matching env var must not rescue a custom provider.
      vi.stubEnv("OPENAI_API_KEY", "env-openai");
      const row = await makeCustom();
      const err = await resolveModelSpec(db, credentials, orgId, `${row.id}/qwen-coder`).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NoCredentialsError);
      expect((err as NoCredentialsError).message).toMatch(/provider Together has no API key/);
      expect((err as NoCredentialsError).model?.id).toBe(`${row.id}/qwen-coder`);
    });

    it("an EMPTY-STRING stored org key behaves as missing on the custom branch too", async () => {
      const row = await makeCustom();
      await saveKey(row.id, "");
      const err = await resolveModelSpec(db, credentials, orgId, `${row.id}/qwen-coder`).then(
        () => undefined,
        (e: unknown) => e,
      );
      // Uniform empty≡missing semantics: the custom branch's "has no API
      // key" message stays accurate for a blanked-out credential.
      expect(err).toBeInstanceOf(NoCredentialsError);
      expect((err as NoCredentialsError).message).toMatch(/provider Together has no API key/);
    });

    it("model not on the provider's list throws (inactive model)", async () => {
      const row = await makeCustom();
      await saveKey(row.id, "k");
      await expect(resolveModelSpec(db, credentials, orgId, `${row.id}/not-listed`)).rejects.toThrow(
        /not active on provider Together/,
      );
    });

    it("deleted/unknown provider namespace throws", async () => {
      await expect(resolveModelSpec(db, credentials, orgId, "prov_gone/m1")).rejects.toThrow(
        /unknown or deleted provider: prov_gone/,
      );
    });
  });

  describe("disabled provider", () => {
    it("throws even with a valid key present", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "anthropic", name: "Anthropic" });
      await saveKey(row.id, "org-anthropic");
      await updateLlmProvider(db, orgId, row.id, { enabled: false });
      await expect(resolveModelSpec(db, credentials, orgId, `anthropic/${ANTHROPIC_MODEL}`)).rejects.toThrow(
        /provider Anthropic is disabled/,
      );
    });
  });

  describe("per-turn key freshness (no caching)", () => {
    it("rotating the stored credential between resolutions returns the new key", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Rotate",
        baseUrl: "https://x/v1",
        models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
      });
      await saveKey(row.id, "key-1");
      const first = await resolveModelSpec(db, credentials, orgId, `${row.id}/m1`);
      expect(first?.apiKey).toBe("key-1");

      await saveKey(row.id, "key-2"); // rotate
      const second = await resolveModelSpec(db, credentials, orgId, `${row.id}/m1`);
      expect(second?.apiKey).toBe("key-2");
    });
  });

  describe("canonical-id round-trip (carry-forward 1) — resolve(resolve(spec).id) is identity", () => {
    it("anthropic", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const r1 = await resolveModelSpec(db, credentials, orgId, ANTHROPIC_MODEL);
      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.model.id);
      expect(r2?.model.provider).toBe(r1?.model.provider);
      expect(r2?.model.id).toBe(r1?.model.id);
      expect(r2?.apiKey).toBe(r1?.apiKey);
    });

    it("openai", async () => {
      const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
      await saveKey(row.id, "org-openai");
      const r1 = await resolveModelSpec(db, credentials, orgId, `openai/${OPENAI_MODEL}`);
      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.canonicalId!);
      expect(r1?.model.id).toBe(OPENAI_MODEL); // wire id
      expect(r1?.canonicalId).toBe(`openai/${OPENAI_MODEL}`); // persisted spec
      expect(r2?.model.provider).toBe("openai");
      expect(r2?.model.id).toBe(r1?.model.id);
      expect(r2?.canonicalId).toBe(r1?.canonicalId);
      expect(r2?.apiKey).toBe(r1?.apiKey);
    });

    it("custom", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://x/v1",
        models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
      });
      await saveKey(row.id, "org-custom");
      const r1 = await resolveModelSpec(db, credentials, orgId, `${row.id}/m1`);
      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.canonicalId!);
      expect(r1?.model.id).toBe("m1"); // wire id
      expect(r1?.canonicalId).toBe(`${row.id}/m1`);
      expect(r2?.model.provider).toBe(row.id);
      expect(r2?.model.id).toBe(r1?.model.id);
      expect(r2?.canonicalId).toBe(r1?.canonicalId);
      expect(r2?.apiKey).toBe(r1?.apiKey);
    });

    it("openrouter — NESTED-slash model id survives the round-trip", async () => {
      // Registry model ids themselves contain a slash
      // (`deepseek/deepseek-v4-pro`), so the namespaced spec has two:
      // `parseModelId` must split on the FIRST only, and the WIRE id keeps
      // its inner slash un-prefixed (OpenRouter 400s on `openrouter/x/y`).
      const row = await createLlmProvider(db, { orgId, kind: "openrouter", name: "OpenRouter" });
      await saveKey(row.id, "org-openrouter");
      const spec = "openrouter/deepseek/deepseek-v4-pro";
      const r1 = await resolveModelSpec(db, credentials, orgId, spec);
      expect(r1?.model.id).toBe("deepseek/deepseek-v4-pro"); // wire id
      expect(r1?.canonicalId).toBe(spec);
      expect(r1?.model.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(r1?.apiKey).toBe("org-openrouter");
      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.canonicalId!);
      expect(r2?.model.id).toBe(r1?.model.id);
      expect(r2?.canonicalId).toBe(r1?.canonicalId);
      expect(r2?.apiKey).toBe(r1?.apiKey);
    });

    it("openrouter — env fallback via OPENROUTER_API_KEY with no row (zero-config)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "env-openrouter");
      const r = await resolveModelSpec(db, credentials, orgId, "openrouter/moonshotai/kimi-k2.6");
      expect(r?.model.provider).toBe("openrouter");
      expect(r?.apiKey).toBe("env-openrouter");
    });

    it("openrouter — a NON-REGISTRY row selection (live-catalog pick) synthesizes and round-trips", async () => {
      const row = await createLlmProvider(db, {
        orgId,
        kind: "openrouter",
        name: "OpenRouter",
        models: [
          {
            id: "moonshotai/kimi-k3",
            name: "MoonshotAI: Kimi K3",
            contextWindow: 1_048_576,
            pricing: { input: 3, output: 15 },
          },
        ],
      });
      await saveKey(row.id, "org-openrouter");
      const spec = "openrouter/moonshotai/kimi-k3";
      const r1 = await resolveModelSpec(db, credentials, orgId, spec);
      expect(r1?.model.id).toBe("moonshotai/kimi-k3"); // wire id
      expect(r1?.canonicalId).toBe(spec);
      expect(r1?.model.api).toBe("openai-completions");
      expect(r1?.model.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(r1?.model.contextWindow).toBe(1_048_576);
      const r2 = await resolveModelSpec(db, credentials, orgId, r1!.canonicalId!);
      expect(r2?.model.id).toBe(r1?.model.id);
      expect(r2?.apiKey).toBe(r1?.apiKey);

      // Un-selected non-registry ids stay unresolvable ("unknown model id").
      expect(await resolveModelSpec(db, credentials, orgId, "openrouter/vendor/never-heard-of-it")).toBeNull();
    });
  });

  describe("no-db degradation", () => {
    it("resolves known kinds via env when db is undefined; custom specs throw", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
      const known = await resolveModelSpec(undefined, credentials, orgId, ANTHROPIC_MODEL);
      expect(known?.model.provider).toBe("anthropic");
      expect(known?.apiKey).toBe("env-anthropic");
      await expect(resolveModelSpec(undefined, credentials, orgId, "prov_x/m1")).rejects.toThrow(
        /unknown or deleted provider/,
      );
    });
  });
});

describe("EngineHost model resolution wiring", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("new-session precedence: orgPreferences[0] used when no user default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await setOrgModelPreferences(db, "local-org", ["anthropic/claude-sonnet-4-5"]);

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("new-session precedence: user default wins over orgPreferences[0]", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));
    await setOrgModelPreferences(db, "local-org", ["anthropic/claude-sonnet-4-5"]);

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("claude-opus-4-5");
  });

  it("new-session precedence: hardcoded claude-haiku-4-5 when nothing is set", async () => {
    api = await bootTestApi();
    const { engineHost } = api.providers;
    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("claude-haiku-4-5");
  });

  it("new-session precedence: falls through past a keyless-but-enabled custom preference (fix a's pin — key-delete can't brick new sessions)", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const row = await createLlmProvider(db, {
      orgId: "local-org",
      kind: "openai_compatible",
      name: "Custom",
      baseUrl: "https://x/v1",
      models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
    });
    // enabled: true (default), but no org credential was ever saved for
    // this row — same state as an admin deleting the key via DELETE
    // .../:id/key without also rewriting orgPreferences.
    await setOrgModelPreferences(db, "local-org", [`${row.id}/m1`, "anthropic/claude-haiku-4-5"]);

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("anthropic/claude-haiku-4-5");
  });

  it("new-session precedence: falls through past a disabled provider to the next preference", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const row = await createLlmProvider(db, {
      orgId: "local-org",
      kind: "openai_compatible",
      name: "Custom",
      baseUrl: "https://x/v1",
      models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
    });
    await updateLlmProvider(db, "local-org", row.id, { enabled: false });
    await setOrgModelPreferences(db, "local-org", [`${row.id}/m1`, "anthropic/claude-haiku-4-5"]);

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("anthropic/claude-haiku-4-5");
  });

  it("new-session precedence: all preferences inactive falls through to the hardcoded default", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const row = await createLlmProvider(db, {
      orgId: "local-org",
      kind: "openai_compatible",
      name: "Custom",
      baseUrl: "https://x/v1",
      models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
    });
    await updateLlmProvider(db, "local-org", row.id, { enabled: false });
    await setOrgModelPreferences(db, "local-org", [`${row.id}/m1`]);

    const session = await defaultAssistantSessionFor(api.providers, 
      { type: "user", id: "local-user" },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("claude-haiku-4-5");
  });

  it("new-session precedence: owning team's default beats orgPreferences[0] (TKAI-255)", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await db.update(teams).set({ defaultModel: "anthropic/claude-sonnet-4-5" }).where(eq(teams.id, team.id));
    await setOrgModelPreferences(db, "local-org", ["anthropic/claude-haiku-4-5"]);

    const session = await engineHost.sessionFor("team-owned-1", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      ownerTeamId: team.id,
    });
    expect(session.options.model.id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("new-session precedence: user default wins over the owning team's default (TKAI-255)", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await db.update(teams).set({ defaultModel: "anthropic/claude-sonnet-4-5" }).where(eq(teams.id, team.id));
    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

    const session = await engineHost.sessionFor("team-owned-2", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      ownerTeamId: team.id,
    });
    expect(session.options.model.id).toBe("claude-opus-4-5");
  });

  it("new-session precedence: a personal session never reads a team's default (TKAI-255)", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    // The user is a member (creator) of a team with a default, but the
    // session is user-owned — no ownerTeamId — so the team tier is skipped.
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await db.update(teams).set({ defaultModel: "anthropic/claude-sonnet-4-5" }).where(eq(teams.id, team.id));

    const session = await engineHost.sessionFor("personal-1", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    expect(session.options.model.id).toBe("claude-haiku-4-5");
  });

  it("new-session precedence: a team assistant session uses the team's default (TKAI-255)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await db.update(teams).set({ defaultModel: "anthropic/claude-sonnet-4-5" }).where(eq(teams.id, team.id));

    const session = await defaultAssistantSessionFor(api.providers,
      { type: "team", id: team.id },
      { actorUserId: "local-user", orgId: "local-org" },
    );
    expect(session.options.model.id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("restore-no-clobber: a later team-default change never clobbers a team-owned session's persisted model (TKAI-255)", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const team = await createTeam(db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await db.update(teams).set({ defaultModel: "anthropic/claude-sonnet-4-5" }).where(eq(teams.id, team.id));

    const meta = {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
      ownerTeamId: team.id,
    };
    const session = await engineHost.sessionFor("team-owned-restore", meta);
    expect(session.options.model.id).toBe("anthropic/claude-sonnet-4-5");

    engineHost.evictAll();
    await db.update(teams).set({ defaultModel: "claude-opus-4-5" }).where(eq(teams.id, team.id));

    const restored = await engineHost.sessionFor("team-owned-restore", meta);
    expect(restored.options.model.id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("restore still throws when the persisted model's provider was disabled after the fact", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineCredentials } = api.providers;
    const row = await createLlmProvider(db, {
      orgId: "local-org",
      kind: "openai_compatible",
      name: "Custom",
      baseUrl: "https://x/v1",
      models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
    });
    await engineCredentials.save({ type: "org", id: "local-org" }, `llm:${row.id}`, {
      type: "api_key",
      apiKey: "org-custom",
    });
    const spec = `${row.id}/m1`;

    const session = await engineHost.sessionFor("restore-disabled", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    await session.setModel(spec);
    expect(session.options.modelSpec).toBe(spec);
    expect(session.options.model.id).toBe("m1"); // wire id

    engineHost.evictAll();
    await updateLlmProvider(db, "local-org", row.id, { enabled: false });

    await expect(
      engineHost.sessionFor("restore-disabled", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp",
      }),
    ).rejects.toThrow(/provider Custom is disabled/);
  });

  it("restore-no-clobber: a persisted namespaced custom model restores verbatim", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineCredentials } = api.providers;

    // Stand up a resolvable custom provider so setModel/restore both succeed.
    const row = await createLlmProvider(db, {
      orgId: "local-org",
      kind: "openai_compatible",
      name: "Custom",
      baseUrl: "https://x/v1",
      models: [{ id: "m1", name: "M1", contextWindow: 8000 }],
    });
    await engineCredentials.save({ type: "org", id: "local-org" }, `llm:${row.id}`, {
      type: "api_key",
      apiKey: "org-custom",
    });
    const spec = `${row.id}/m1`;

    const session = await engineHost.sessionFor("restore-custom", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    await session.setModel(spec);
    expect(session.options.modelSpec).toBe(spec);
    expect(session.options.model.id).toBe("m1"); // wire id

    engineHost.evictAll();
    // Change the user default to prove restore prefers the persisted model.
    await db.update(users).set({ defaultModel: "claude-opus-4-5" }).where(eq(users.id, "local-user"));

    const restored = await engineHost.sessionFor("restore-custom", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    expect(restored.options.modelSpec).toBe(spec);
    expect(restored.options.model.id).toBe("m1"); // wire id, restored verbatim
    expect(restored.options.model.provider).toBe(row.id);
  });
});
