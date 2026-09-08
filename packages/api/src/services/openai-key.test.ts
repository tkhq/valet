import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialOwner, StoredCredential } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs } from "../schema/index.js";
import { createLlmProvider, updateLlmProvider } from "./llm-providers.js";
import { resolveOpenAiCredential } from "./openai-key.js";
import type { OnePasswordService } from "./onepassword.js";

const orgId = "org1";
const userId = "u1";
const ctx = { orgId, userId, scopes: ["org", "personal"] as const };
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
  // The openai probe runs for every session. A team- or org-owned session
  // must not title-search the frozen actor's personal vault for an OpenAI key.
  it("honors the caller's scopes when it falls through to the vault lookup", async () => {
    const tried: string[] = [];
    const onePassword = {
      tokenConnected: async () => true,
      listVaults: async () => [],
      resolveReference: async () => "",
      resolveCredential: async (row: StoredCredential) => row,
      findCandidates: async () => [],
      findCredentialForService: async (scope: string) => {
        tried.push(scope);
        return null;
      },
    } satisfies OnePasswordService;
    const got = await resolveOpenAiCredential(
      db,
      credentials,
      { orgId: "o1", userId: "u1", scopes: ["org"] },
      {},
      onePassword,
    );
    expect(got).toBeNull();
    expect(tried).toEqual(["org"]);
  });

  // A team session must find the same org-scope OpenAI item a team workflow
  // finds: the generic team read runs under the service's fallback policy.
  describe("team owner", () => {
    const teamOwner: CredentialOwner = { type: "team", id: "team_1" };

    function vaultWith(items: Record<string, string>, tried: string[]): OnePasswordService {
      return {
        tokenConnected: async () => true,
        listVaults: async () => [],
        resolveReference: async () => "",
        resolveCredential: async (row: StoredCredential) => row,
        findCandidates: async () => [],
        findCredentialForService: async (scope: string, _ctx, service: string) => {
          tried.push(scope);
          return items[`${scope}:${service}`] ?? null;
        },
      } satisfies OnePasswordService;
    }

    it("reaches an org-scoped vault item under reference-only, the policy a team workflow reads with", async () => {
      const tried: string[] = [];
      const onePassword = vaultWith({ "org:openai": "sk-org-vault" }, tried);
      const cred = await resolveOpenAiCredential(
        db,
        credentials,
        { orgId, owner: teamOwner, scopes: ["org"], orgFallback: "reference-only" },
        {},
        onePassword,
      );
      expect(cred).toEqual({ type: "api_key", apiKey: "sk-org-vault" });
      expect(tried).toEqual(["org"]);
    });

    it("stops at the team row when the policy is none", async () => {
      const tried: string[] = [];
      const onePassword = vaultWith({ "org:openai": "sk-org-vault" }, tried);
      const cred = await resolveOpenAiCredential(
        db,
        credentials,
        { orgId, owner: teamOwner, scopes: ["org"], orgFallback: "none" },
        {},
        onePassword,
      );
      expect(cred).toBeNull();
      expect(tried).toEqual([]);
    });

    it("the team's own row still wins over the vault", async () => {
      await credentials.save(teamOwner, "openai", { type: "api_key", apiKey: "sk-team" });
      const onePassword = vaultWith({ "org:openai": "sk-org-vault" }, []);
      const cred = await resolveOpenAiCredential(
        db,
        credentials,
        { orgId, owner: teamOwner, scopes: ["org"], orgFallback: "reference-only" },
        {},
        onePassword,
      );
      expect(cred?.apiKey).toBe("sk-team");
    });
  });
});
