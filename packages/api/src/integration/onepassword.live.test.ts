/**
 * 1Password service — live e2e against the real 1Password SDK (design doc
 * "Testing" section: "Live-gated e2e behind `OP_SERVICE_ACCOUNT_TOKEN`
 * exercising the real SDK").
 *
 * Key-gated (`describeIfToken`, matching every other suite in this
 * directory, e.g. `llm-providers.e2e.test.ts`'s `describeIfKey`): skips
 * cleanly when `OP_SERVICE_ACCOUNT_TOKEN` isn't set in the shell, so CI
 * without the token still passes.
 *
 * Uses the REAL default `createClient` (no fake/stub SDK client) — only the
 * `CredentialStore` and `getAllowPersonal` deps are stubbed, mirroring the
 * unit-test pattern in `../services/onepassword.test.ts` but without the
 * `createClient` override.
 *
 * The optional `OP_TEST_REFERENCE` (an `op://vault/item/field` string in the
 * service account's vault) additionally exercises `resolveReference`. The
 * resolved secret value is asserted only by length — NEVER printed or
 * included in an assertion message — to avoid leaking it into test output.
 */
import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { createOnePasswordService, ONEPASSWORD_SERVICE, type OnePasswordCtx } from "../services/onepassword.js";

const OP_SERVICE_ACCOUNT_TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
const OP_TEST_REFERENCE = process.env.OP_TEST_REFERENCE;

const describeIfToken = OP_SERVICE_ACCOUNT_TOKEN ? describe : describe.skip;

/** Single-row in-memory `CredentialStore` holding just the org token row. */
function tokenOnlyStore(token: string): CredentialStore {
  const key = (o: CredentialOwner, s: string) => `${o.type}:${o.id}:${s}`;
  const orgRow: StoredCredential = { type: "service_account", apiKey: token };
  const m = new Map<string, StoredCredential>([[key({ type: "org", id: "org-1" }, ONEPASSWORD_SERVICE), orgRow]]);
  return {
    get: async (o, s) => m.get(key(o, s)) ?? null,
    save: async (o, s, c) => {
      m.set(key(o, s), c);
    },
    delete: async (o, s) => {
      m.delete(key(o, s));
    },
    list: async () => [],
  };
}

describeIfToken("api integration: 1Password — live SDK", () => {
  const ctx: OnePasswordCtx = { orgId: "org-1", userId: "user-1" };

  it("listVaults returns at least one real vault via the org service-account token", async () => {
    if (!OP_SERVICE_ACCOUNT_TOKEN) throw new Error("unreachable: describeIfToken gated on OP_SERVICE_ACCOUNT_TOKEN");
    const svc = createOnePasswordService({
      credentials: tokenOnlyStore(OP_SERVICE_ACCOUNT_TOKEN),
      getAllowPersonal: async () => true,
      // No `createClient` override — exercises the real default SDK adapter.
    });

    const vaults = await svc.listVaults("org", ctx);
    expect(vaults.length).toBeGreaterThan(0);
    for (const vault of vaults) {
      expect(typeof vault.id).toBe("string");
      expect(typeof vault.title).toBe("string");
    }
  });

  it.runIf(Boolean(OP_TEST_REFERENCE))(
    "resolveReference resolves OP_TEST_REFERENCE to a non-empty secret",
    async () => {
      if (!OP_SERVICE_ACCOUNT_TOKEN) throw new Error("unreachable: describeIfToken gated on OP_SERVICE_ACCOUNT_TOKEN");
      if (!OP_TEST_REFERENCE) throw new Error("unreachable: gated on OP_TEST_REFERENCE");
      const svc = createOnePasswordService({
        credentials: tokenOnlyStore(OP_SERVICE_ACCOUNT_TOKEN),
        getAllowPersonal: async () => true,
      });

      const secret = await svc.resolveReference("org", ctx, OP_TEST_REFERENCE);
      // Length-only assertion — the resolved secret value must never appear
      // in a test name, assertion message, or console output.
      expect(secret.length).toBeGreaterThan(0);
    },
  );
});
