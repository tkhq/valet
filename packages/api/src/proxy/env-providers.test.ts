// TKAI-710: an `env:` provider follows the env key across restarts.
import { afterEach, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, listLlmProviders } from "../services/llm-providers.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { resolveOpenAiCredential } from "../services/openai-key.js";
import { ensureEnvProviders, resolveUpstream } from "./upstream.js";

afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const fixture = await freshTestPgDb();
  const db = fixture.appDb;
  const credentials = new PgCredentialStore(fixture.pgdb, deriveSecretKey("test-key"));
  await db.insert(orgs).values({ id: "org", name: "Env keys", createdAt: 1 });
  return { db, credentials };
}

it("uses the rotated env key after a restart, for every reader", async () => {
  const { db, credentials } = await setup();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-A");
  vi.stubEnv("OPENAI_API_KEY", "sk-oai-A");
  await ensureEnvProviders(db, credentials, "org");
  // Rotation: new env keys, then the next boot runs the same step.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-B");
  vi.stubEnv("OPENAI_API_KEY", "sk-oai-B");
  await ensureEnvProviders(db, credentials, "org");

  expect((await listLlmProviders(db, "org")).map((r) => r.name).sort()).toEqual(["env:anthropic", "env:openai"]);
  expect((await resolveUpstream(db, credentials, "org", "anthropic"))?.apiKey).toBe("sk-ant-B");
  expect((await resolveUpstream(db, credentials, "org", "openai"))?.apiKey).toBe("sk-oai-B");
  expect((await resolveModelSpec(db, credentials, "org", "anthropic/claude-haiku-4-5"))?.apiKey).toBe("sk-ant-B");
  expect((await resolveOpenAiCredential(db, credentials, { orgId: "org", scopes: [] }))?.apiKey).toBe("sk-oai-B");
});

it("deletes a stale seeded copy from an earlier build and keeps a key saved in Settings", async () => {
  const { db, credentials } = await setup();
  const owner = { type: "org" as const, id: "org" };
  const seeded = await createLlmProvider(db, { orgId: "org", kind: "anthropic", name: "env:anthropic" });
  await credentials.save(owner, `llm:${seeded.id}`, { type: "api_key", apiKey: "sk-ant-stale" });
  const saved = await createLlmProvider(db, { orgId: "org", kind: "openai", name: "env:openai" });
  await credentials.save(owner, `llm:${saved.id}`, { type: "api_key", apiKey: "sk-oai-admin", metadata: { last4: "dmin" } });
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-B");
  vi.stubEnv("OPENAI_API_KEY", "sk-oai-B");

  await ensureEnvProviders(db, credentials, "org");

  expect(await credentials.get(owner, `llm:${seeded.id}`)).toBeNull();
  expect((await resolveUpstream(db, credentials, "org", "anthropic"))?.apiKey).toBe("sk-ant-B");
  expect((await resolveUpstream(db, credentials, "org", "openai"))?.apiKey).toBe("sk-oai-admin");
  expect((await listLlmProviders(db, "org"))).toHaveLength(2);
});
