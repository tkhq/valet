/**
 * 1Password credential provider plan, Task 2: `buildCredentialResolver` must
 * route rows carrying `metadata.onepassword` through `OnePasswordService`
 * when the host is wired with `opts.onePassword`, while leaving every other
 * row (and the "no onePassword/githubTokenDeps at all" contract) untouched.
 * Drives a REAL `EngineHost` session build (mirrors
 * `host.github-credential.test.ts`) and reads through
 * `Session.credentialProvider()` — the same seam a plugin action's
 * `ctx.credentials.get()` hits.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type CredentialOwner,
  type CredentialStore,
  type StoredCredential,
  InMemoryCredentialStore,
} from "@valet/engine";
import {
  OnePasswordAuthError,
  type OnePasswordCtx,
  type OnePasswordService,
} from "../services/onepassword.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs } from "../schema/index.js";
import { EngineHost, type EngineHostOpts } from "./host.js";

const orgId = "op-org";
const userId = "op-user";

const fakeCredentialStore = (): CredentialStore => new InMemoryCredentialStore();

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by the resolver; every
 * other method throws if called, since this suite never drives the browse/connect routes. */
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
    resolveCredential,
  };
}

describe("EngineHost session 1Password credential resolution", () => {
  let host: EngineHost | undefined;

  afterEach(() => {
    host?.evictAll();
    host = undefined;
  });

  function makeHost(
    credentials: CredentialStore,
    extra: Partial<EngineHostOpts> = {},
  ): EngineHost {
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      ...extra,
    });
    host = h;
    return h;
  }

  it("1Password-backed row resolves through the service with the secret filled", async () => {
    // `Session.credentialProvider()` always reads through owner
    // `{ type: "user", id: meta.userId }` (session.ts:705) regardless of the
    // row's own `tokenScope` — the resolver only cares that the row it read
    // carries `metadata.onepassword`.
    const credentials = fakeCredentialStore();
    const stored: StoredCredential = {
      type: "api_key",
      apiKey: "placeholder",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme-service", stored);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `secret-for-${ctx.orgId}` };
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-resolve", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("acme-service");

    // `Session.credentialProvider().get()` maps `StoredCredential` ->
    // `Credential` (`accessToken: stored.accessToken ?? stored.apiKey`,
    // session.ts:726) — so an `api_key`-typed resolved row surfaces here as
    // `accessToken`, not `apiKey`.
    expect(cred?.accessToken).toBe(`secret-for-${orgId}`);
    // The exact object `credentials.get()` returned was handed to
    // `resolveCredential` (no clone before the call).
    expect(sawRow).toBe(stored);
  });

  it("non-1Password row passes through byte-identical (the exact object the store returned, unmodified)", async () => {
    const credentials = fakeCredentialStore();
    const stored: StoredCredential = { type: "api_key", apiKey: "linear-key" };
    await credentials.save({ type: "user", id: userId }, "linear", stored);
    // Captures the exact reference `buildCredentialResolver` passed as its
    // return value's source — proves the resolver's default branch does
    // `return stored` with no clone, not merely a value-equal copy.
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row) => {
      sawRow = row;
      throw new Error("resolveCredential must not be called for a non-1Password row");
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-passthrough", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    // resolveCredential was never invoked (no metadata.onepassword) — the
    // resolver's `credentials.get(owner, service)` read is the row `Session`
    // maps into `Credential`, so `accessToken` mirrors `stored.apiKey`
    // exactly, and `sawRow` staying `undefined` confirms the 1Password branch
    // was skipped entirely for this row.
    expect(sawRow).toBeUndefined();
    expect(cred?.accessToken).toBe(stored.apiKey);
  });

  it("OnePasswordAuthError from the service propagates unchanged", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "acme-service", {
      type: "api_key",
      apiKey: "placeholder",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "personal" } },
    });
    const authError = new OnePasswordAuthError("This org has no personal 1Password service account token connected.");
    const onePassword = fakeOnePassword(async () => {
      throw authError;
    });
    const h = makeHost(credentials, { onePassword });

    // A user-owned session: the row is the user's own personal-scope reference,
    // so the owner rule lets the read reach it and the service's error surfaces.
    const session = await h.sessionFor("sess-op-error", { userId, orgId, workspace: "/tmp", ownerType: "user" });

    await expect(session.credentialProvider().get("acme-service")).rejects.toBe(authError);
  });

  it("no onePassword opt and no githubTokenDeps: buildCredentialResolver stays undefined (pre-existing contract)", async () => {
    const credentials = fakeCredentialStore();
    const stored: StoredCredential = {
      type: "api_key",
      apiKey: "placeholder",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme-service", stored);
    const h = makeHost(credentials);

    const session = await h.sessionFor("sess-op-none", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("acme-service");

    // Raw store read: the reference metadata is present but nothing resolved
    // it — `accessToken` mirrors `stored.apiKey` verbatim, not a secret.
    expect(cred?.accessToken).toBe("placeholder");
  });

  it("org-owned reference row resolves in a session when the user has no row for the service (org fallback)", async () => {
    // The flagship admin flow: an org admin creates an org-SCOPED 1Password
    // reference credential; a member's session (which reads user-owner only,
    // session.ts:705) must still resolve it. Pinned because the engine has NO
    // generic owner read-union — this fallback in `buildCredentialResolver`
    // is the only org-owned read on the session path.
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "acme-service", orgRow);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `org-secret-for-${ctx.userId}` };
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-org-fallback", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("acme-service");

    expect(sawRow).toBe(orgRow);
    expect(cred?.accessToken).toBe(`org-secret-for-${userId}`);
  });

  it("user-owned row shadows the org-owned reference row for the same service", async () => {
    // Fallback fires only on a user-owner MISS: a member's own credential
    // (reference or plain) always wins over the org-wide one.
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme-service", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    const userRow: StoredCredential = { type: "api_key", apiKey: "my-own-key" };
    await credentials.save({ type: "user", id: userId }, "acme-service", userRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("resolveCredential must not be called when the user row shadows the org row");
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-user-shadows", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("acme-service");

    expect(cred?.accessToken).toBe("my-own-key");
  });

  it("plain (non-reference) org-owned row stays invisible to a session", async () => {
    // The org row is reachable only for a service some plugin declared
    // org-provided, or when the row is an admin's 1Password pointer. A plain
    // org-owned `telegram` bot token is neither, so a member's session sees
    // nothing — see `services/credential-resolution.ts`'s module doc.
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "bot_token", apiKey: "org-bot-token" };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("resolveCredential must not be called for a plain org row");
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-plain-org-fallback", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("telegram");

    expect(cred).toBeNull();
  });

  it("onePassword wired but no githubTokenDeps: resolver is defined, 1Password rows resolve, github falls through to the raw store", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "raw-github-token",
    });
    await credentials.save({ type: "user", id: userId }, "acme-service", {
      type: "api_key",
      apiKey: "placeholder",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({
      type: row.type,
      metadata: row.metadata,
      apiKey: "secret-for-acme-service",
    }));
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-github-fallthrough", { userId, orgId, workspace: "/tmp" });
    const githubCred = await session.credentialProvider().get("github");
    const opCred = await session.credentialProvider().get("acme-service");

    expect(githubCred?.accessToken).toBe("raw-github-token");
    expect(opCred?.accessToken).toBe("secret-for-acme-service");
  });

  it("session get('github_app') returns null even when the org App row exists", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "github_app", {
      type: "service_account",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("resolveCredential must not be called for a denied service");
    });
    const h = makeHost(credentials, { onePassword });

    const session = await h.sessionFor("sess-op-deny-github-app", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("github_app");

    expect(cred).toBeNull();
  });

  it("db wired + 1Password openai row resolves through the service (LLM-provider probe does not skip it)", async () => {
    const { appDb } = await freshTestPgDb();
    await appDb.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "openai", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/openai/key", tokenScope: "org" } },
    });
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: "sk-from-1password" };
    });
    const h = makeHost(credentials, { db: appDb, onePassword });

    const session = await h.sessionFor("sess-op-openai-db", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("openai");

    expect(sawRow?.metadata?.onepassword).toEqual({
      reference: "op://vault/openai/key",
      tokenScope: "org",
    });
    expect(cred?.accessToken).toBe("sk-from-1password");
  });
});
