import { describe, expect, it, vi } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import {
  createOnePasswordService,
  onePasswordMeta,
  OnePasswordAuthError,
  ONEPASSWORD_SERVICE,
  type OpClient,
  type OnePasswordCtx,
  titleNamesService,
} from "./onepassword.js";

function memStore(): CredentialStore {
  const m = new Map<string, StoredCredential>();
  const k = (o: CredentialOwner, s: string) => `${o.type}:${o.id}:${s}`;
  return {
    get: async (o, s) => m.get(k(o, s)) ?? null,
    save: async (o, s, c) => {
      m.set(k(o, s), c);
    },
    delete: async (o, s) => {
      m.delete(k(o, s));
    },
    list: async () => [],
  };
}

function fakeClient(overrides?: Partial<OpClient>): OpClient {
  return {
    secrets: { resolve: vi.fn(async (ref: string) => `secret-for-${ref}`) },
    vaults: { list: async () => [{ id: "v1", title: "Vault One" }] },
    items: {
      list: async () => [{ id: "i1", title: "Item One", vaultId: "v1" }],
      getWithSecrets: async () => ({ title: "Item One", fields: [] }),
    },
    ...overrides,
  };
}

const ctx: OnePasswordCtx = { orgId: "org-1", userId: "user-1" };

describe("createOnePasswordService", () => {
  it("resolveReference org scope uses the ORG-owned onepassword token row", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    const secret = await svc.resolveReference("org", ctx, "op://Vault/Item/field");
    expect(secret).toBe("secret-for-op://Vault/Item/field");
  });

  it("resolveReference org scope throws OnePasswordAuthError when the org token row is missing", async () => {
    const credentials = memStore();
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    await expect(svc.resolveReference("org", ctx, "op://Vault/Item/field")).rejects.toThrow(
      OnePasswordAuthError,
    );
    await expect(svc.resolveReference("org", ctx, "op://Vault/Item/field")).rejects.toThrow(
      /no organization 1Password service account token/,
    );
  });

  it("resolveReference personal scope uses the USER-owned token row", async () => {
    const credentials = memStore();
    await credentials.save({ type: "user", id: ctx.userId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "user-token",
    });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    const secret = await svc.resolveReference("personal", ctx, "op://Vault/Item/field");
    expect(secret).toBe("secret-for-op://Vault/Item/field");
  });

  it("resolveReference personal scope throws OnePasswordAuthError when the user token row is missing", async () => {
    const credentials = memStore();
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    await expect(svc.resolveReference("personal", ctx, "op://Vault/Item/field")).rejects.toThrow(
      OnePasswordAuthError,
    );
    await expect(svc.resolveReference("personal", ctx, "op://Vault/Item/field")).rejects.toThrow(
      /no personal 1Password service account token/,
    );
  });

  it("resolveReference personal scope disabled by org toggle throws before token lookup", async () => {
    const credentials = memStore();
    // No token row saved at all — if the toggle check ran after token lookup,
    // this would throw the "no personal token" error instead.
    const getAllowPersonal = vi.fn(async () => false);
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal,
      createClient: async () => fakeClient(),
    });
    await expect(svc.resolveReference("personal", ctx, "op://Vault/Item/field")).rejects.toThrow(
      /disabled by your organization/,
    );
    expect(getAllowPersonal).toHaveBeenCalledWith(ctx.orgId);
  });

  it("caches resolved references within the TTL and re-resolves after it expires", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    let t = 0;
    const resolve = vi.fn(async (ref: string) => `secret-for-${ref}`);
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient({ secrets: { resolve } }),
      now: () => t,
    });

    await svc.resolveReference("org", ctx, "op://Vault/Item/field");
    await svc.resolveReference("org", ctx, "op://Vault/Item/field");
    expect(resolve).toHaveBeenCalledTimes(1);

    t += 5 * 60_000 + 1;
    await svc.resolveReference("org", ctx, "op://Vault/Item/field");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("caches SDK clients per token, re-creating when the stored token changes", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "token-a",
    });
    const createClient = vi.fn(async () => fakeClient());
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient,
    });

    await svc.resolveReference("org", ctx, "op://Vault/Item/field-a");
    await svc.resolveReference("org", ctx, "op://Vault/Item/field-b");
    expect(createClient).toHaveBeenCalledTimes(1);

    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "token-b",
    });
    await svc.resolveReference("org", ctx, "op://Vault/Item/field-c");
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("resolveCredential fills apiKey for type api_key", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    const row: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Vault/Item/field", tokenScope: "org" } },
    };
    const resolved = await svc.resolveCredential(row, ctx);
    expect(resolved).toEqual({
      type: "api_key",
      apiKey: "secret-for-op://Vault/Item/field",
      metadata: row.metadata,
    });
  });

  it("resolveCredential fills accessToken for type oauth2", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    const row: StoredCredential = {
      type: "oauth2",
      metadata: { onepassword: { reference: "op://Vault/Item/field", tokenScope: "org" } },
    };
    const resolved = await svc.resolveCredential(row, ctx);
    expect(resolved).toEqual({
      type: "oauth2",
      accessToken: "secret-for-op://Vault/Item/field",
      metadata: row.metadata,
    });
  });

  it("resolveCredential passes through a row without metadata.onepassword unchanged", async () => {
    const credentials = memStore();
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => fakeClient(),
    });
    const row: StoredCredential = { type: "api_key", apiKey: "raw-key" };
    const resolved = await svc.resolveCredential(row, ctx);
    expect(resolved).toBe(row);
  });

  it("onePasswordMeta narrows valid metadata and rejects malformed metadata", () => {
    expect(
      onePasswordMeta({
        type: "api_key",
        metadata: { onepassword: { reference: "op://Vault/Item/field", tokenScope: "org" } },
      }),
    ).toEqual({ reference: "op://Vault/Item/field", tokenScope: "org" });

    expect(onePasswordMeta({ type: "api_key" })).toBeNull();
    expect(onePasswordMeta({ type: "api_key", metadata: {} })).toBeNull();
    expect(
      onePasswordMeta({
        type: "api_key",
        metadata: { onepassword: { reference: 42, tokenScope: "org" } },
      }),
    ).toBeNull();
    expect(
      onePasswordMeta({
        type: "api_key",
        metadata: { onepassword: { reference: "op://Vault/Item/field", tokenScope: "bogus" } },
      }),
    ).toBeNull();
  });

  it("wraps SDK failures as a fixed client message and never interpolates the SDK text or reference", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () =>
        fakeClient({
          secrets: {
            resolve: vi.fn(async () => {
              throw new Error("item not found");
            }),
          },
        }),
    });
    try {
      await svc.resolveReference("org", ctx, "op://Vault/Item/field");
      expect.unreachable("expected resolveReference to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OnePasswordAuthError);
      const message = (err as Error).message;
      expect(message).toBe("1Password request failed");
      expect(message).not.toContain("item not found");
      expect(message).not.toContain("op://Vault/Item/field");
      expect(message).not.toContain("secret-for-");
      expect(log).toHaveBeenCalled();
      const logged = String(log.mock.calls[0]?.[0]);
      expect(logged).toContain("op://Vault/Item/field");
    } finally {
      log.mockRestore();
    }
  });

  it("wraps a listing call's SDK failure (client construction) without leaking the SDK text", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () => {
        throw new Error("token expired");
      },
    });
    try {
      await expect(svc.listVaults("org", ctx)).rejects.toBeInstanceOf(OnePasswordAuthError);
      await expect(svc.listVaults("org", ctx)).rejects.toThrow("1Password request failed");
    } finally {
      log.mockRestore();
    }
  });

  it("wraps a listing call's SDK failure (client method) without double-wrapping an already-typed error", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient: async () =>
        fakeClient({
          vaults: {
            list: async () => {
              throw new OnePasswordAuthError("already typed, do not wrap again");
            },
          },
        }),
    });
    try {
      await svc.listVaults("org", ctx);
      expect.unreachable("expected listVaults to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OnePasswordAuthError);
      expect((err as Error).message).toBe("already typed, do not wrap again");
      // Not prefixed with any additional "1Password ... failed" wrapper text.
      expect((err as Error).message).not.toMatch(/failed:/);
    }
  });

  it("evicts a poisoned client cache entry so a subsequent call can succeed", async () => {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, {
      type: "service_account",
      apiKey: "org-token",
    });
    let attempt = 0;
    const createClient = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient network blip");
      }
      return fakeClient();
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => true,
      createClient,
    });

    try {
      await expect(svc.listVaults("org", ctx)).rejects.toThrow(OnePasswordAuthError);
      expect(createClient).toHaveBeenCalledTimes(1);

      const vaults = await svc.listVaults("org", ctx);
      expect(vaults).toEqual([{ id: "v1", title: "Vault One" }]);
      expect(createClient).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
});


describe("titleNamesService", () => {
  // Escape first, then loosen. The other order escaped the class it had just
  // inserted, so no id with a separator ever matched its own item.
  it("matches ids with separators against titles with spaces", () => {
    expect(titleNamesService("Google Calendar", "google_calendar")).toBe(true);
    expect(titleNamesService("Slack User", "slack-user")).toBe(true);
    expect(titleNamesService("google-docs prod", "google-docs")).toBe(true);
  });
  it("stays on word boundaries", () => {
    expect(titleNamesService("GitHub token", "github")).toBe(true);
    expect(titleNamesService("Linearity", "linear")).toBe(false);
  });
});

describe("findCredentialForService", () => {
  function inventoryClient(calls: string[], overrides?: Partial<OpClient>): OpClient {
    return fakeClient({
      vaults: {
        list: async () => {
          calls.push("vaults.list");
          return [{ id: "v1", title: "Vault One" }];
        },
      },
      items: {
        list: async () => {
          calls.push("items.list");
          return [{ id: "i1", title: "Google Calendar", vaultId: "v1" }];
        },
        getWithSecrets: async () => {
          calls.push("getWithSecrets");
          return { title: "Google Calendar", fields: [{ id: "f1", title: "credential", fieldType: "Concealed", value: "k-123" }] };
        },
      },
      ...overrides,
    });
  }
  async function withOrgToken() {
    const credentials = memStore();
    await credentials.save({ type: "org", id: ctx.orgId }, ONEPASSWORD_SERVICE, { type: "service_account", apiKey: "org-token" });
    return credentials;
  }

  it("finds the secret by item title through a concealed field", async () => {
    const calls: string[] = [];
    const svc = createOnePasswordService({
      credentials: await withOrgToken(),
      getAllowPersonal: async () => true,
      createClient: async () => inventoryClient(calls),
    });
    expect(await svc.findCredentialForService("org", ctx, "google_calendar")).toBe("k-123");
  });

  it("walks the vaults once for many services", async () => {
    const calls: string[] = [];
    const svc = createOnePasswordService({
      credentials: await withOrgToken(),
      getAllowPersonal: async () => true,
      createClient: async () => inventoryClient(calls),
    });
    await svc.findCredentialForService("org", ctx, "google_calendar");
    await svc.findCredentialForService("org", ctx, "linear");
    await svc.findCredentialForService("org", ctx, "slack");
    expect(calls.filter((c) => c === "vaults.list")).toHaveLength(1);
    expect(calls.filter((c) => c === "items.list")).toHaveLength(1);
  });

  // The gate runs before the cache: a hit must not outlive the toggle.
  it("re-checks the personal toggle on every call, cache or not", async () => {
    let allowed = true;
    const credentials = memStore();
    await credentials.save({ type: "user", id: ctx.userId }, ONEPASSWORD_SERVICE, { type: "service_account", apiKey: "me" });
    const svc = createOnePasswordService({
      credentials,
      getAllowPersonal: async () => allowed,
      createClient: async () => inventoryClient([]),
    });
    expect(await svc.findCredentialForService("personal", ctx, "google_calendar")).toBe("k-123");
    allowed = false;
    await expect(svc.findCredentialForService("personal", ctx, "google_calendar")).rejects.toMatchObject({ kind: "disabled" });
  });

  // A one-time code is good for about thirty seconds; caching it for five
  // minutes hands out expired codes with a valid shape.
  it("does not cache a one-time code", async () => {
    const calls: string[] = [];
    let code = 0;
    const client = inventoryClient(calls, {
      items: {
        list: async () => [{ id: "i1", title: "Acme", vaultId: "v1" }],
        getWithSecrets: async () => {
          calls.push("getWithSecrets");
          code += 1;
          return { title: "Acme", fields: [{ id: "t", title: "one-time password", fieldType: "Totp", details: { type: "Otp", content: { code: `00000${code}` } } }] };
        },
      },
    });
    const svc = createOnePasswordService({
      credentials: await withOrgToken(),
      getAllowPersonal: async () => true,
      createClient: async () => client,
    });
    expect(await svc.findCredentialForService("org", ctx, "acme")).toBe("000001");
    expect(await svc.findCredentialForService("org", ctx, "acme")).toBe("000002");
  });

  // A scope with no token is the common case for a service that is not in
  // 1Password. It fails at the token read, before any vault is listed.
  it("a missing token fails before any vault is touched", async () => {
    const calls: string[] = [];
    const svc = createOnePasswordService({
      credentials: memStore(),
      getAllowPersonal: async () => true,
      createClient: async () => inventoryClient(calls),
    });
    await expect(svc.findCredentialForService("org", ctx, "linear")).rejects.toMatchObject({ kind: "no_token" });
    expect(calls).toEqual([]);
  });
});
