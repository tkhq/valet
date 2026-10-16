/**
 * 1Password credential provider plan, Task 6: unit coverage for the shared
 * owner-precedence + 1Password-reference-resolution helper. See
 * `credential-resolution.ts`'s module doc for the contract and the
 * deliberate behavior change (plain org rows now resolve via user-row-miss
 * fallback, not just 1Password reference rows).
 */
import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { InMemoryCredentialStore } from "@valet/engine";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordService } from "./onepassword.js";
import { CredentialReferenceBrokenError } from "../plugins/team-credential-store.js";
import { LinearAppTokenStore } from "../plugins/linear-app-token-store.js";
import { startLinearFixture } from "../test-helpers/linear-fixture.js";
import {
  resolveOrgCredentialRead,
  readTeamCredential,
  resolveTeamCredentialRead,
  resolveUserCredentialRead,
  onePasswordScopesFor,
  isNativeAppCredentialService,
  nativeAppCredentialServiceFor,
  resolveAppCredentialRead,
  resolveNativeAppCredentialRead,
  resolveOrgChannelCredentialRead,
} from "./credential-resolution.js";
import type { ValetPlugin } from "@valet/engine";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import githubPlugin from "@valet/plugin-github/plugin";
import { configMcpPlugins } from "../plugins/config-mcp.js";

const orgId = "cr-org";
const userId = "cr-user";

/** Minimal in-memory `CredentialStore` — keyed by `${owner.type}:${owner.id}:${service}`. */
const fakeCredentialStore = (): CredentialStore => new InMemoryCredentialStore();

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by this helper. */
function fakeOnePassword(
  resolveCredential: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    findCredentialForService: async () => null,
    findCandidates: async () => [],
    resolveCredential,
  };
}

describe("internal-service deny list", () => {
  // `onepassword` / `github_app` / `llm:*` rows are internal secrets. Without
  // this guard a user-row miss would hand them back as ordinary credentials.
  it("resolveUserCredentialRead returns null for service 'onepassword' even when the org token row exists", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-org-service-account-token",
    });
    await credentials.save({ type: "user", id: userId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-personal-service-account-token",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — reserved service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "onepassword", "org-provided");

    expect(result).toBeNull();
  });

  it("resolveOrgCredentialRead returns null for service 'onepassword'", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-org-service-account-token",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — reserved service");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "onepassword");

    expect(result).toBeNull();
  });

  it("resolveUserCredentialRead returns null for service 'github_app'", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "github_app", {
      type: "service_account",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "github_app", "org-provided");

    expect(result).toBeNull();
  });

  it.each(["github_app", "linear_app"])("resolveOrgCredentialRead returns null for service %s", async (service) => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, service, {
      type: "service_account",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, service);

    expect(result).toBeNull();
  });

  it("resolveUserCredentialRead returns null for llm:* provider keys", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "llm:prov_1", {
      type: "api_key",
      apiKey: "sk-org-provider",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "llm:prov_1", "org-provided");

    expect(result).toBeNull();
  });
});

describe("resolveUserCredentialRead", () => {
  it("user row (plain) shadows an org row for the same service", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "linear", { type: "api_key", apiKey: "org-key" });
    const userRow: StoredCredential = { type: "api_key", apiKey: "my-key" };
    await credentials.save({ type: "user", id: userId }, "linear", userRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "linear", "org-provided");

    expect(result).toBe(userRow);
  });

  it("user row (1Password reference) shadows an org row — org row never read", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://org/acme/field", tokenScope: "org" } },
    });
    const userRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://user/acme/field", tokenScope: "personal" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme", userRow);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `resolved-for-${ctx.userId}` };
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(sawRow).toBe(userRow);
    expect(result?.apiKey).toBe(`resolved-for-${userId}`);
  });

  it("user-row miss reaches a plain org row when the service is org-provided", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "bot_token", apiKey: "org-bot-token" };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "telegram", "org-provided");

    expect(result).toBe(orgRow);
  });

  // The containment rule. A plain org row is machinery, not a shared secret:
  // an org-owned `linear` row carries `metadata.webhookSecret`
  // (`plugins/http-linear-connection.ts`), so a service nobody declared org-provided
  // must not hand its whole row to a member's session.
  it("user-row miss does NOT reach a plain org row under reference-only", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "api_key",
      apiKey: "org-linear-key",
      metadata: { webhookSecret: "must-not-leak" },
    };
    await credentials.save({ type: "org", id: orgId }, "linear", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — the org row must not even be read");
    });

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result).toBeNull();
  });

  it('"none" never reaches the org row, even for a reference', async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve under 'none'");
    });

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "acme",
      "none",
    );

    expect(result).toBeNull();
  });

  it("user-row miss falls back to an org row carrying a 1Password reference", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "acme", orgRow);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `org-secret-for-${ctx.userId}` };
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(sawRow).toBe(orgRow);
    expect(result?.apiKey).toBe(`org-secret-for-${userId}`);
  });

  it("returns null when neither the user nor the org row exists", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — nothing stored");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "nope", "org-provided");

    expect(result).toBeNull();
  });

  it("onePassword absent: rows pass through byte-identical (same object, no clone)", async () => {
    const credentials = fakeCredentialStore();
    const userRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme", userRow);

    const result = await resolveUserCredentialRead({ credentials }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(result).toBe(userRow);
  });
});

describe("resolveOrgCredentialRead", () => {
  it("resolves an org-owned 1Password reference row with no userId in ctx", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-bot-token" };
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "telegram");

    expect(result?.apiKey).toBe("resolved-bot-token");
    expect(sawCtx).toEqual({ orgId, userId: "", scopes: ["org"] });
  });

  // An org read refuses a personal-scope row on the scopes alone, before the
  // service is consulted at all. The write path rejects this combination
  // today, so the row is unreachable through the API — but an org-owned
  // workflow run supplies a real `userId`, and without this gate such a row
  // would resolve through THAT person's personal token.
  it("org row carrying a personal-tokenScope reference is refused, and the service is never called", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Personal/Acme/field", tokenScope: "personal" } },
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — the scopes exclude personal");
    });

    await expect(
      resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "acme"),
    ).rejects.toMatchObject({ kind: "scope" });
    await expect(
      resolveOrgCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org"] }, "acme"),
    ).rejects.toBeInstanceOf(OnePasswordAuthError);
  });

  it("plain org row passes through unchanged (no onePassword call)", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "api_key", apiKey: "plain-org-key" };
    await credentials.save({ type: "org", id: orgId }, "linear", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "linear");

    expect(result).toBe(orgRow);
  });

  it("returns null when no org row exists", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — nothing stored");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "nope");

    expect(result).toBeNull();
  });

  // INV-P1 / vector P5: the org `linear` row is the app connection. Its
  // metadata holds the inbound webhook HMAC secret, so an action gets the
  // access token and nothing else.
  describe("app credential org row (grant: client_credentials)", () => {
    const appRow = (tokenExpiresAt: number): StoredCredential => ({
      type: "oauth2",
      accessToken: "lin-app-token",
      metadata: {
        webhookSecret: "hook-secret-value",
        workspaceId: "ws-value",
        grant: "client_credentials",
        tokenExpiresAt,
        connectionId: "conn-value",
      },
    });

    it("hands an org-owned read the access token with no metadata", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow(Date.now() + 10 * 86_400_000));

      const result = await resolveOrgCredentialRead({ credentials }, { orgId, userId, scopes: ["org"] }, "linear");

      expect(result).toEqual({ type: "oauth2", accessToken: "lin-app-token" });
      const text = JSON.stringify(result);
      for (const leaked of ["webhookSecret", "hook-secret-value", "workspaceId", "ws-value", "connectionId", "conn-value", "grant", "tokenExpiresAt"]) {
        expect(text).not.toContain(leaked);
      }
      // The stored row keeps its metadata: only the value handed out is reduced.
      expect((await credentials.get({ type: "org", id: orgId }, "linear"))?.metadata?.webhookSecret).toBe("hook-secret-value");
    });

    it("still renews a renewal-due row through LinearAppTokenStore, then hands out the fresh token only", async () => {
      const fixture = startLinearFixture();
      try {
        const inner = fakeCredentialStore();
        await inner.save({ type: "org", id: orgId }, "linear_app", { type: "service_account", apiKey: "secret", metadata: { clientId: "client", connectionId: "conn-value" } });
        await inner.save({ type: "org", id: orgId }, "linear", appRow(Date.now() - 1));
        const credentials = new LinearAppTokenStore(inner, { env: { LINEAR_API_URL: fixture.url } });

        const result = await resolveOrgCredentialRead({ credentials }, { orgId, scopes: ["org"] }, "linear");

        expect(fixture.calls).toHaveLength(1);
        expect(result).toEqual({ type: "oauth2", accessToken: "lin_app_token" });
        expect(JSON.stringify(result)).not.toContain("hook-secret-value");
        const saved = await inner.get({ type: "org", id: orgId }, "linear");
        expect(saved?.accessToken).toBe("lin_app_token");
        expect(saved?.metadata).toMatchObject({ webhookSecret: "hook-secret-value", workspaceId: "ws-value", grant: "client_credentials" });
      } finally {
        await fixture.close();
      }
    });

    it("returns null for an app row with no token", async () => {
      const credentials = fakeCredentialStore();
      const { accessToken: _token, ...noToken } = appRow(Date.now() + 86_400_000);
      await credentials.save({ type: "org", id: orgId }, "linear", noToken);

      expect(await resolveOrgCredentialRead({ credentials }, { orgId }, "linear")).toBeNull();
    });

    it("strips signing secrets from an org row that is not an app credential, and keeps the rest", async () => {
      const credentials = fakeCredentialStore();
      const botRow: StoredCredential = {
        type: "bot_token",
        apiKey: "xoxb-1",
        metadata: { webhookSecret: "slack-signing", signingSecret: "slack-signing-2", clientSecret: "slack-client", appToken: "xapp-1", teamId: "T1", botUserId: "U1" },
      };
      await credentials.save({ type: "org", id: orgId }, "slack", botRow);

      const read = await resolveOrgCredentialRead({ credentials }, { orgId }, "slack");
      expect(read).toEqual({ type: "bot_token", apiKey: "xoxb-1", metadata: { teamId: "T1", botUserId: "U1" } });
      for (const leaked of ["slack-signing", "slack-client", "xapp-1"]) expect(JSON.stringify(read)).not.toContain(leaked);
      // The stored row keeps its secrets for inbound verification.
      expect((await credentials.get({ type: "org", id: orgId }, "slack"))?.metadata?.webhookSecret).toBe("slack-signing");
    });

    it("hands the channel transport the whole org row, secrets included", async () => {
      const credentials = fakeCredentialStore();
      const botRow: StoredCredential = { type: "bot_token", apiKey: "xoxb-1", metadata: { webhookSecret: "slack-signing", teamId: "T1" } };
      await credentials.save({ type: "org", id: orgId }, "slack", botRow);

      expect(await resolveOrgChannelCredentialRead({ credentials }, { orgId }, "slack")).toEqual(botRow);
    });
  });
});

// The point of connecting a token: an agent asking for a credential nobody
// configured gets the one already in the vaults.
describe("vault lookup when no row exists", () => {
  const orgId = "org-1";
  const userId = "user-1";

  function fakeWithLookup(secret: string | null, onLookup?: (scope: string) => void): OnePasswordService {
    const unused = (): never => {
      throw new Error("not exercised by this suite");
    };
    return {
      tokenConnected: unused,
      listVaults: unused,
      resolveReference: unused,
      findCandidates: async () => [],
      findCredentialForService: async (scope) => {
        onLookup?.(scope);
        return secret;
      },
      resolveCredential: async (row: StoredCredential) => row,
    };
  }

  it("resolves a service with no user or org row from the vaults", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("vault-secret");

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result?.apiKey).toBe("vault-secret");
  });

  it("returns null when nothing in the vaults matches", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup(null);

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result).toBeNull();
  });

  it("a stored row still wins: the vaults are the fallback, not the source", async () => {
    const credentials = fakeCredentialStore();
    const userRow: StoredCredential = { type: "api_key", apiKey: "my-own-key" };
    await credentials.save({ type: "user", id: userId }, "linear", userRow);
    const onePassword = fakeWithLookup("vault-secret");

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result?.apiKey).toBe("my-own-key");
  });
  // The scope set is decided from the session owner, once, and honored here.
  it("with scopes [org] never consults the personal vault", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("ACTOR-PRIVATE", (scope) => tried.push(scope));
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org"] },
      "linear",
      "reference-only",
    );
    expect(tried).toEqual(["org"]);
    expect(got?.apiKey).toBe("ACTOR-PRIVATE");
  });

  // "none" means no escalation at all; a vault lookup is an escalation.
  it("orgFallback none returns null without a vault lookup", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("SHOULD-NOT-BE-READ", (scope) => tried.push(scope));
    const got = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "linear", "none");
    expect(got).toBeNull();
    expect(tried).toEqual([]);
  });
  // The stored-row path is the one the vault-title search does not cover: a
  // user row carrying a personal-scope reference must not resolve for a
  // session whose owner rule excludes the personal scope.
  it("a personal-scope user row reads as absent when scopes exclude personal", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Private/Linear/token", tokenScope: "personal" } },
    });
    const onePassword: OnePasswordService = {
      ...fakeWithLookup(null, (scope) => tried.push(`lookup:${scope}`)),
      resolveCredential: async (row: StoredCredential) => {
        tried.push("resolveCredential");
        return { ...row, apiKey: "ACTOR-PRIVATE" };
      },
    };
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org"] },
      "linear",
      "reference-only",
    );
    // Not resolved through the personal token; the read falls through to the
    // org row (none) and the org-scope vault lookup (nothing), and answers null.
    expect(tried).toEqual(["lookup:org"]);
    expect(got).toBeNull();
  });

  it("the same row resolves for a user-owned session", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Private/Linear/token", tokenScope: "personal" } },
    });
    const onePassword: OnePasswordService = {
      ...fakeWithLookup(null),
      resolveCredential: async (row: StoredCredential) => ({ ...row, apiKey: "ACTOR-PRIVATE" }),
    };
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: onePasswordScopesFor("user") },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("ACTOR-PRIVATE");
  });
});

describe("resolveTeamCredentialRead", () => {
  const teamId = "cr-team";

  it("returns a direct team row and does not read the org row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      apiKey: "team-secret",
    });
    await credentials.save({ type: "org", id: orgId }, "linear", {
      type: "api_key",
      apiKey: "org-secret",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("team-secret");
  });

  it("does not fall back to a plain org row when the team has no credential", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "linear", {
      type: "api_key",
      apiKey: "org-secret",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got).toBeNull();
  });

  it("reads the org row when the service is org-provided", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      accessToken: "org-bot",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "slack",
      "org-provided",
    );
    expect(got?.accessToken).toBe("org-bot");
  });

  function vaultWithLookup(secret: string | null, onLookup: (scope: string) => void): OnePasswordService {
    const unused = (): never => {
      throw new Error("not exercised by this suite");
    };
    return {
      tokenConnected: unused,
      listVaults: unused,
      resolveReference: unused,
      findCandidates: async () => [],
      findCredentialForService: async (scope) => {
        onLookup(scope);
        return secret;
      },
      resolveCredential: async (row: StoredCredential) => row,
    };
  }

  it("team-row miss reaches the org-scoped 1Password item, on the caller's scopes alone", async () => {
    const scopesTried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = vaultWithLookup("vault-secret", (scope) => scopesTried.push(scope));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId, scopes: onePasswordScopesFor("team") },
      "linear",
      "reference-only",
    );
    expect(scopesTried).toEqual(["org"]);
    expect(got?.apiKey).toBe("vault-secret");
  });

  it("a team row wins without consulting the vault", async () => {
    const scopesTried: string[] = [];
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      apiKey: "team-secret",
    });
    const onePassword = vaultWithLookup("vault-secret", (scope) => scopesTried.push(scope));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId, scopes: onePasswordScopesFor("team") },
      "linear",
      "reference-only",
    );
    expect(scopesTried).toEqual([]);
    expect(got?.apiKey).toBe("team-secret");
  });

  it("resolves a granted 1Password reference on a team row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "from-vault" }));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("from-vault");
  });

  it("resolves a team row reference when the team has no grant row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "from-vault" }));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("from-vault");
  });

  // The org-provided row is the other place a team read dereferences an
  // op:// ref. A lease narrows that read too, or the grant is a fence with a
  // gate left open for every service a plugin declares org-provided.
  it("ignores obsolete grants for a 1Password reference on the org-provided row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Other/bot", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "resolved" }));
    await expect(
      resolveTeamCredentialRead({ credentials, onePassword }, { orgId, teamId }, "slack", "org-provided"),
    ).resolves.toMatchObject({ apiKey: "resolved" });
  });

  it("resolves a granted 1Password reference on the org-provided row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/bot"] },
    });
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Acme/bot", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, accessToken: "bot-from-vault" }));
    const got = await resolveTeamCredentialRead({ credentials, onePassword }, { orgId, teamId }, "slack", "org-provided");
    expect(got?.accessToken).toBe("bot-from-vault");
  });

  it("ignores obsolete grants for a 1Password reference on a team row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Other/password", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "resolved" }));
    await expect(
      resolveTeamCredentialRead(
        { credentials, onePassword },
        { orgId, teamId },
        "linear",
        "reference-only",
      ),
    ).resolves.toMatchObject({ apiKey: "resolved" });
  });

  // Each member's share is its own account. The acting member's share comes
  // first, then the team's own connection; another member's share is used
  // only with their approval.
  describe("member shares", () => {
    const shares = (members: string[]) => async () => members;
    async function storeWith(rows: Array<[CredentialOwner, StoredCredential]>, service = "linear"): Promise<CredentialStore> {
      const credentials = fakeCredentialStore();
      for (const [owner, row] of rows) await credentials.save(owner, service, row);
      return credentials;
    }
    const bea = { type: "user" as const, id: "bea" };
    const al = { type: "user" as const, id: "al" };
    const team = { type: "team" as const, id: teamId };

    it("uses the acting member's own share before the team's connection", async () => {
      const credentials = await storeWith([[al, { type: "api_key", apiKey: "al-key" }], [team, { type: "api_key", apiKey: "team-key" }]]);
      const deps = { credentials, shares: shares(["bea", "al"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ apiKey: "al-key" }) });
      // Without a share of their own, a member uses the team's connection.
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "cy" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ apiKey: "team-key" }) });
    });

    it("asks the member whose share it would use, and uses it once they approved", async () => {
      const credentials = await storeWith([[bea, { type: "api_key", apiKey: "bea-key" }]]);
      const deps = { credentials, shares: shares(["bea"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: null, approvalFrom: "bea" });
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al", mayBorrow: async (id) => id === "bea" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ apiKey: "bea-key" }) });
    });

    it("uses a later sharer who already approved before asking an older one", async () => {
      const credentials = await storeWith([[bea, { type: "api_key", apiKey: "bea-key" }], [{ type: "user", id: "cy" }, { type: "api_key", apiKey: "cy-key" }]]);
      const deps = { credentials, shares: shares(["bea", "cy"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al", mayBorrow: async (id) => id === "cy" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ apiKey: "cy-key" }) });
    });

    it("reads past a team connection that can no longer refresh, still asking the share's member", async () => {
      const dead: StoredCredential = { type: "oauth2", accessToken: "dead", refreshToken: "rt", expiresAt: 1, metadata: { refreshFailedAt: 2, refreshRefused: true } };
      const fresh: StoredCredential = { type: "oauth2", accessToken: "bea-fresh", expiresAt: Date.now() + 3_600_000 };
      const deps = { credentials: await storeWith([[team, dead], [bea, fresh]]), shares: shares(["bea"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: null, approvalFrom: "bea" });
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al", mayBorrow: async (id) => id === "bea" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ accessToken: "bea-fresh" }) });
      // With nothing else to use, the dead row stays the answer, so the caller still sees the provider's refusal.
      const alone = { credentials: await storeWith([[team, dead]]), shares: shares([]) };
      await expect(readTeamCredential(alone, { orgId, teamId, userId: "al" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ accessToken: "dead" }) });
    });

    it("skips expired OAuth without refresh for an approved share, and requires consent otherwise", async () => {
      const expired: StoredCredential = { type: "oauth2", accessToken: "expired", expiresAt: 1 };
      const fresh: StoredCredential = { type: "oauth2", accessToken: "bea-fresh", expiresAt: Date.now() + 3_600_000 };
      const deps = { credentials: await storeWith([[team, expired], [bea, fresh]]), shares: shares(["bea"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al" }, "linear", "none"))
        .resolves.toEqual({ credential: null, approvalFrom: "bea" });
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al", mayBorrow: async () => true }, "linear", "none"))
        .resolves.toEqual({ credential: expect.objectContaining({ accessToken: "bea-fresh" }) });
      await expect(readTeamCredential({ credentials: await storeWith([[team, expired]]) }, { orgId, teamId }, "linear", "none"))
        .resolves.toEqual({ credential: null });
    });

    it("does not select an expired share, including the acting member's own share", async () => {
      const expired: StoredCredential = { type: "oauth2", accessToken: "expired", expiresAt: 1 };
      const deps = { credentials: await storeWith([[al, expired], [bea, expired], [team, { type: "api_key", apiKey: "team-key" }]]), shares: shares(["al", "bea"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al", mayBorrow: async () => true }, "linear", "none"))
        .resolves.toEqual({ credential: expect.objectContaining({ apiKey: "team-key" }) });
    });

    it("keeps an expired team connection whose refresh failed only temporarily", async () => {
      const expired: StoredCredential = { type: "oauth2", accessToken: "team", refreshToken: "rt", expiresAt: 1, metadata: { refreshFailedAt: 2 } };
      const deps = { credentials: await storeWith([[team, expired], [bea, { type: "api_key", apiKey: "bea-key" }]]), shares: shares(["bea"]) };
      await expect(readTeamCredential(deps, { orgId, teamId, userId: "al" }, "linear", "reference-only"))
        .resolves.toEqual({ credential: expect.objectContaining({ accessToken: "team" }) });
    });

    it("falls back to the org bot behind a share whose account is gone", async () => {
      const credentials = await storeWith([[{ type: "org", id: orgId }, { type: "bot_token", accessToken: "org-bot" }]], "slack");
      const got = await resolveTeamCredentialRead({ credentials, shares: shares(["departed"]) }, { orgId, teamId }, "slack", "org-provided");
      expect(got?.accessToken).toBe("org-bot");
    });

    // Readiness reads with "none" and reports a broken share as broken. A
    // silent null there would arm a trigger that fails on every fire.
    it("names the fix when only a broken share remains", async () => {
      const credentials = await storeWith([]);
      await expect(resolveTeamCredentialRead({ credentials, shares: shares(["departed"]) }, { orgId, teamId, mayBorrow: async () => true }, "slack", "none"))
        .rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    });
  });

  it("returns null for denied services", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      apiKey: "must-not-leak",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "onepassword",
      "org-provided",
    );
    expect(got).toBeNull();
  });
});

// Native integration credential policy
// (docs/specs/2026-10-15-native-integration-credential-policy-design.md).
describe("native app credentials", () => {
  const appRow = (extra: Partial<StoredCredential> = {}): StoredCredential => ({
    type: "oauth2",
    accessToken: "lin-app-token",
    metadata: { webhookSecret: "hook-secret-value", workspaceId: "ws-value", grant: "client_credentials", connectionId: "conn-value" },
    ...extra,
  });
  const leakedKeys = ["webhookSecret", "hook-secret-value", "workspaceId", "ws-value", "connectionId", "conn-value", "grant"];
  const expectBare = (result: StoredCredential | null) => {
    expect(result).toEqual({ type: "oauth2", accessToken: "lin-app-token" });
    const text = JSON.stringify(result);
    for (const leaked of leakedKeys) expect(text).not.toContain(leaked);
  };
  const plugins: ValetPlugin[] = [linearPlugin, slackPlugin, githubPlugin];

  describe("classification (Part A)", () => {
    it("marks GitHub, Slack, and Linear native with their app credential services", () => {
      expect(githubPlugin).toMatchObject({ native: true, appCredentialService: "github:installation" });
      expect(slackPlugin).toMatchObject({ native: true, appCredentialService: "slack" });
      expect(linearPlugin).toMatchObject({ native: true, appCredentialService: "linear:app" });
      for (const service of ["github:installation", "slack", "linear:app"]) {
        expect(isNativeAppCredentialService(plugins, service)).toBe(true);
      }
    });

    it("never marks a config-declared MCP server native (INV-P2)", () => {
      const configPlugins = configMcpPlugins(
        [{ name: "acme-docs", url: "https://mcp.acme.test/mcp", auth: "oauth" }, { name: "linear-app", url: "https://mcp.acme.test/x", auth: "none" }],
        {},
      );
      for (const plugin of configPlugins) {
        expect(plugin.native).toBeUndefined();
        expect(plugin.appCredentialService).toBeUndefined();
      }
      for (const service of ["acme-docs", "linear-app", "linear:app"]) {
        expect(isNativeAppCredentialService(configPlugins, service)).toBe(false);
      }
    });
  });

  it("maps a native service to its app credential service, and nothing else", () => {
    expect(nativeAppCredentialServiceFor(plugins, "linear")).toBe("linear:app");
    expect(nativeAppCredentialServiceFor(plugins, "slack")).toBe("slack");
    expect(nativeAppCredentialServiceFor(plugins, "github")).toBe("github:installation");
    expect(nativeAppCredentialServiceFor(plugins, "acme-docs")).toBeUndefined();
    const configPlugins = configMcpPlugins([{ name: "acme-docs", url: "https://mcp.acme.test/mcp", auth: "oauth" }], {});
    expect(nativeAppCredentialServiceFor(configPlugins, "acme-docs")).toBeUndefined();
  });

  describe("readTeamCredential laterTier", () => {
    const deadTeamRow: StoredCredential = { type: "oauth2", accessToken: "dead", expiresAt: 1, metadata: { refreshRefused: true } };

    it("gives a dead team connection way to a later tier that answers", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "team", id: "t1" }, "linear", deadTeamRow);

      const withLater = await readTeamCredential({ credentials }, { orgId, teamId: "t1", laterTier: async () => true }, "linear", "reference-only");
      expect(withLater).toEqual({ credential: null });
      const without = await readTeamCredential({ credentials }, { orgId, teamId: "t1", laterTier: async () => false }, "linear", "reference-only");
      expect(without.credential?.accessToken).toBe("dead");
    });

    it("gives a broken share way to a later tier that answers, and throws without one", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "user", id: userId }, "linear", { type: "oauth2", accessToken: "expired", expiresAt: 1 });
      const deps = { credentials, shares: async () => [userId] };

      expect(await readTeamCredential(deps, { orgId, teamId: "t1", userId, laterTier: async () => true }, "linear", "reference-only")).toEqual({ credential: null });
      await expect(readTeamCredential(deps, { orgId, teamId: "t1", userId }, "linear", "reference-only")).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    });

    it("is not consulted when a tier answers", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "team", id: "t1" }, "linear", { type: "oauth2", accessToken: "team-linear" });
      let calls = 0;

      const result = await readTeamCredential({ credentials }, { orgId, teamId: "t1", laterTier: async () => { calls += 1; return true; } }, "linear", "reference-only");
      expect(result.credential?.accessToken).toBe("team-linear");
      expect(calls).toBe(0);
    });
  });

  it("an app-pinned read of slack carries the bot token without the signing secret (INV-P1)", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-app",
      metadata: { webhookSecret: "slack-signing", teamId: "T1" },
    });

    const read = await resolveNativeAppCredentialRead({ credentials }, { orgId }, "slack", "slack", plugins);
    expect(read).toEqual({ type: "bot_token", accessToken: "xoxb-app", metadata: { teamId: "T1" } });
    expect(JSON.stringify(read)).not.toContain("webhookSecret");
  });

  describe("resolveAppCredentialRead", () => {
    it("answers linear:app from the org linear app row as a bare token (INV-P1)", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow());

      expectBare(await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", plugins));
      // The stored row keeps its metadata.
      expect((await credentials.get({ type: "org", id: orgId }, "linear"))?.metadata?.webhookSecret).toBe("hook-secret-value");
    });

    it("keeps a top-level expiresAt, which carries no secret", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow({ expiresAt: 1_900_000_000_000 }));

      expect(await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", plugins))
        .toEqual({ type: "oauth2", accessToken: "lin-app-token", expiresAt: 1_900_000_000_000 });
    });

    it("returns null when no native plugin names the app credential service (INV-P2)", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow());
      const notNative: ValetPlugin = { ...linearPlugin, native: undefined, appCredentialService: undefined };

      expect(await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", [notNative])).toBeNull();
      expect(await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", undefined)).toBeNull();
    });

    it("returns null when the org linear row is a person's connection, not the app", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", { type: "oauth2", accessToken: "someone", metadata: { login: "x" } });

      expect(await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", plugins)).toBeNull();
    });

    it("returns null with no org row", async () => {
      expect(await resolveAppCredentialRead({ credentials: fakeCredentialStore() }, { orgId }, "linear:app", plugins)).toBeNull();
    });

    it("answers no other service: github:installation and slack resolve through their own paths", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "slack", { type: "bot_token", accessToken: "xoxb" });
      for (const service of ["github:installation", "slack", "linear"]) {
        expect(await resolveAppCredentialRead({ credentials }, { orgId }, service, plugins)).toBeNull();
      }
    });

    it("still renews a renewal-due row through LinearAppTokenStore", async () => {
      const fixture = startLinearFixture();
      try {
        const inner = fakeCredentialStore();
        await inner.save({ type: "org", id: orgId }, "linear_app", { type: "service_account", apiKey: "secret", metadata: { clientId: "client", connectionId: "conn-value" } });
        await inner.save({ type: "org", id: orgId }, "linear", appRow({ metadata: { ...appRow().metadata, tokenExpiresAt: Date.now() - 1 } }));
        const credentials = new LinearAppTokenStore(inner, { env: { LINEAR_API_URL: fixture.url } });

        const result = await resolveAppCredentialRead({ credentials }, { orgId }, "linear:app", plugins);

        expect(fixture.calls).toHaveLength(1);
        expect(result).toEqual({ type: "oauth2", accessToken: "lin_app_token" });
      } finally {
        await fixture.close();
      }
    });
  });

  // INV-P1 at the shared org-row door: every reader that reaches an org row
  // gets an app credential row reduced, not only the org-owned read.
  describe("the shared org-row door", () => {
    it("reduces an app row on the team read's org-provided fallback", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow());

      const { credential } = await readTeamCredential({ credentials }, { orgId, teamId: "t1", userId }, "linear", "org-provided");

      expectBare(credential);
    });

    it("reduces an app row on the user read's org-provided fallback", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "linear", appRow());

      expectBare(await resolveUserCredentialRead({ credentials }, { orgId, userId, scopes: ["org", "personal"] }, "linear", "org-provided"));
    });

    // Part D item 2: a service that is not native never hands out an app
    // credential row, from any reader.
    it("returns null for a non-native service whose org row is an app credential", async () => {
      const credentials = fakeCredentialStore();
      await credentials.save({ type: "org", id: orgId }, "acme-docs", appRow());

      expect(await resolveOrgCredentialRead({ credentials }, { orgId }, "acme-docs")).toBeNull();
      expect((await readTeamCredential({ credentials }, { orgId, teamId: "t1", userId }, "acme-docs", "org-provided")).credential).toBeNull();
      expect(await resolveUserCredentialRead({ credentials }, { orgId, userId, scopes: ["org"] }, "acme-docs", "org-provided")).toBeNull();
    });

    it("leaves the Slack org bot row whole on every reader (Part C Slack)", async () => {
      const credentials = fakeCredentialStore();
      const botRow: StoredCredential = { type: "bot_token", accessToken: "xoxb-1", metadata: { team_id: "T1" } };
      await credentials.save({ type: "org", id: orgId }, "slack", botRow);

      expect(await resolveOrgCredentialRead({ credentials }, { orgId }, "slack")).toEqual(botRow);
      expect((await readTeamCredential({ credentials }, { orgId, teamId: "t1", userId }, "slack", "org-provided")).credential).toEqual(botRow);
      expect(await resolveUserCredentialRead({ credentials }, { orgId, userId, scopes: ["org"] }, "slack", "org-provided")).toEqual(botRow);
    });
  });
});
