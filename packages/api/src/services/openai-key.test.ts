import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialOwner } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { resolveOpenAiCredential } from "./openai-key.js";

const orgId = "org1";
const userId = "u1";
const ctx = { orgId, userId };
const orgOwner: CredentialOwner = { type: "org", id: orgId };
const userOwner: CredentialOwner = { type: "user", id: userId };

describe("resolveOpenAiCredential", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  it("returns null when nothing is configured (tools stay hidden)", async () => {
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {});
    expect(cred).toBeNull();
  });

  it("prefers the org OpenAI LLM-provider key over the env var", async () => {
    const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
    await credentials.save(orgOwner, `llm:${row.id}`, { type: "api_key", apiKey: "sk-org" });
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "sk-env",
    });
    expect(cred).toEqual({ type: "api_key", apiKey: "sk-org" });
  });

  it("skips a disabled provider row and falls back to env", async () => {
    const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
    await credentials.save(orgOwner, `llm:${row.id}`, { type: "api_key", apiKey: "sk-org" });
    await updateLlmProvider(db, orgId, row.id, { enabled: false });
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "sk-env",
    });
    expect(cred).toEqual({ type: "api_key", apiKey: "sk-env" });
  });

  it("skips a provider row whose key is blank", async () => {
    const row = await createLlmProvider(db, { orgId, kind: "openai", name: "OpenAI" });
    await credentials.save(orgOwner, `llm:${row.id}`, { type: "api_key", apiKey: "   " });
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "sk-env",
    });
    expect(cred).toEqual({ type: "api_key", apiKey: "sk-env" });
  });

  it("resolves a stored owner-scoped openai credential before env", async () => {
    await credentials.save(userOwner, "openai", { type: "api_key", apiKey: "sk-direct" });
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "sk-env",
    });
    expect(cred?.apiKey).toBe("sk-direct");
  });

  it("falls back to OPENAI_API_KEY and trims it", async () => {
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "  sk-env  ",
    });
    expect(cred).toEqual({ type: "api_key", apiKey: "sk-env" });
  });

  it("treats a blank env key as absent", async () => {
    const cred = await resolveOpenAiCredential(db, credentials, ctx, {
      OPENAI_API_KEY: "   ",
    });
    expect(cred).toBeNull();
  });
});
