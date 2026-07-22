import { describe, expect, it, vi } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import {
  createOnePasswordService,
  onePasswordMeta,
  OnePasswordAuthError,
  ONEPASSWORD_SERVICE,
  type OpClient,
  type OnePasswordCtx,
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
      get: async () => ({
        id: "i1",
        title: "Item One",
        fields: [{ id: "f1", title: "credential", fieldType: "Concealed" }],
      }),
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

  it("wraps SDK failures in OnePasswordAuthError naming the reference but never the secret", async () => {
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
      expect(message).toContain("op://Vault/Item/field");
      // The resolve call never succeeded, so no resolved secret value
      // (which would look like "secret-for-<ref>" per the fake client) can
      // possibly appear in the wrapped message.
      expect(message).not.toContain("secret-for-");
    }
  });
});
