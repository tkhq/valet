/**
 * 1Password credential provider plan, Task 6: unit coverage for the shared
 * owner-precedence + 1Password-reference-resolution helper. See
 * `credential-resolution.ts`'s module doc for the contract and the
 * deliberate behavior change (plain org rows now resolve via user-row-miss
 * fallback, not just 1Password reference rows).
 */
import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordService } from "./onepassword.js";
import { resolveOrgCredentialRead, resolveUserCredentialRead } from "./credential-resolution.js";

const orgId = "cr-org";
const userId = "cr-user";

/** Minimal in-memory `CredentialStore` — keyed by `${owner.type}:${owner.id}:${service}`. */
function fakeCredentialStore(): CredentialStore {
  const rows = new Map<string, StoredCredential>();
  const key = (owner: CredentialOwner, service: string) => `${owner.type}:${owner.id}:${service}`;
  return {
    async get(owner, service) {
      return rows.get(key(owner, service)) ?? null;
    },
    async save(owner, service, credential) {
      rows.set(key(owner, service), credential);
    },
    async delete(owner, service) {
      rows.delete(key(owner, service));
    },
    async list() {
      return [];
    },
  };
}

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
    listItems: unused,
    getItem: unused,
    resolveReference: unused,
    resolveCredential,
  };
}

describe("reserved onepassword service guard", () => {
  // The `onepassword` rows are the service-account TOKENS. Without this
  // guard a user-row miss would hand back the org's raw 1Password token as
  // an ordinary credential. Symmetric with the write path's reserved-name
  // rejection in routes/credentials.ts.
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

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "onepassword");

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

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "linear");

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

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "acme");

    expect(sawRow).toBe(userRow);
    expect(result?.apiKey).toBe(`resolved-for-${userId}`);
  });

  it("user-row miss falls back to a PLAIN org row (deliberate behavior change)", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "bot_token", apiKey: "org-bot-token" };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "telegram");

    expect(result).toBe(orgRow);
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

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "acme");

    expect(sawRow).toBe(orgRow);
    expect(result?.apiKey).toBe(`org-secret-for-${userId}`);
  });

  it("returns null when neither the user nor the org row exists", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — nothing stored");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId }, "nope");

    expect(result).toBeNull();
  });

  it("onePassword absent: rows pass through byte-identical (same object, no clone)", async () => {
    const credentials = fakeCredentialStore();
    const userRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme", userRow);

    const result = await resolveUserCredentialRead({ credentials }, { orgId, userId }, "acme");

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
    expect(sawCtx).toEqual({ orgId, userId: "" });
  });

  it("org row carrying a personal-tokenScope reference throws the typed OnePasswordAuthError when ctx has no userId", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Personal/Acme/field", tokenScope: "personal" } },
    });
    const authError = new OnePasswordAuthError(
      "This org has no personal 1Password service account token connected.",
    );
    const onePassword = fakeOnePassword(async () => {
      throw authError;
    });

    await expect(resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "acme")).rejects.toBe(authError);
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
});
