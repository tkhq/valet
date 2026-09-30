import { afterEach, describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { LinearAppTokenStore } from "./linear-app-token-store.js";
import { startLinearFixture, type LinearFixture } from "../test-helpers/linear-fixture.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ORG: CredentialOwner = { type: "org", id: "org-1" };

class MemoryStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  async get(owner: CredentialOwner, service: string) { return this.rows.get(`${owner.type}:${owner.id}:${service}`) ?? null; }
  async save(owner: CredentialOwner, service: string, credential: StoredCredential) { this.rows.set(`${owner.type}:${owner.id}:${service}`, credential); }
  async delete(owner: CredentialOwner, service: string) { this.rows.delete(`${owner.type}:${owner.id}:${service}`); }
  async list() { return []; }
}

let fixture: LinearFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function setup(tokenExpiresAt: number, overrides: Parameters<typeof startLinearFixture>[0] = {}) {
  fixture = startLinearFixture(overrides);
  const inner = new MemoryStore();
  await inner.save(ORG, "linear_app", { type: "service_account", apiKey: "secret", metadata: { clientId: "client" } });
  await inner.save(ORG, "linear", {
    type: "oauth2", accessToken: "old",
    metadata: { grant: "client_credentials", tokenExpiresAt, webhookSecret: "hook", workspaceId: "ws" },
  });
  const store = new LinearAppTokenStore(inner, { env: { LINEAR_API_URL: fixture.url }, now: () => NOW });
  return { inner, store, f: fixture };
}

describe("LinearAppTokenStore", () => {
  it("returns a token that is not near expiry without calling Linear", async () => {
    const { store, f } = await setup(NOW + 10 * DAY);
    expect((await store.get(ORG, "linear"))?.accessToken).toBe("old");
    expect(f.calls).toHaveLength(0);
  });

  it("mints a new client_credentials token inside the last day and keeps the other metadata", async () => {
    const { store, inner, f } = await setup(NOW + DAY / 2);
    const [a, b] = await Promise.all([store.get(ORG, "linear"), store.get(ORG, "linear")]);
    expect(a?.accessToken).toBe("lin_app_token");
    expect(b?.accessToken).toBe("lin_app_token");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body).toMatchObject({ grant_type: "client_credentials", client_id: "client", client_secret: "secret", scope: "read,write" });
    const saved = await inner.get(ORG, "linear");
    expect(saved?.metadata).toMatchObject({ webhookSecret: "hook", workspaceId: "ws", grant: "client_credentials" });
    expect(saved?.metadata?.tokenExpiresAt).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it("stamps refreshFailedAt and returns the stored row when renewal fails", async () => {
    const { store, inner } = await setup(NOW - 1, { oauthToken: () => ({ status: 401, body: { error: "invalid_client" } }) });
    expect((await store.get(ORG, "linear"))?.accessToken).toBe("old");
    expect((await inner.get(ORG, "linear"))?.metadata?.refreshFailedAt).toBe(NOW);
  });

  it("does not bring back a credential an admin disconnected during renewal", async () => {
    const held: { inner?: MemoryStore } = {};
    const { store, inner } = await setup(NOW + DAY / 2, { oauthToken: () => {
      // The admin disconnects while Linear is answering.
      void held.inner?.delete(ORG, "linear");
      return { status: 200, body: { access_token: "late", token_type: "Bearer", expires_in: 30 * 24 * 60 * 60, scope: "read write" } };
    } });
    held.inner = inner;
    expect(await store.get(ORG, "linear")).toBeNull();
    expect(await inner.get(ORG, "linear")).toBeNull();
  });

  it("does not call Linear again until the retry window after a failed renewal", async () => {
    let now = NOW;
    const { inner, f } = await setup(NOW - 1, { oauthToken: () => ({ status: 401, body: { error: "invalid_client" } }) });
    const store = new LinearAppTokenStore(inner, { env: { LINEAR_API_URL: f.url }, now: () => now });
    await store.get(ORG, "linear");
    await store.get(ORG, "linear");
    expect(f.calls).toHaveLength(1);
    now += 5 * 60 * 1000;
    await store.get(ORG, "linear");
    expect(f.calls).toHaveLength(2);
  });

  it("leaves personal Linear rows and rows from the older OAuth flow alone", async () => {
    const { store, inner, f } = await setup(NOW + 10 * DAY);
    const user: CredentialOwner = { type: "user", id: "u1" };
    await inner.save(user, "linear", { type: "oauth2", accessToken: "personal", metadata: { grant: "client_credentials", tokenExpiresAt: NOW - 1 } });
    await inner.save(ORG, "linear", { type: "oauth2", accessToken: "legacy", metadata: { webhookSecret: "hook" } });
    expect((await store.get(user, "linear"))?.accessToken).toBe("personal");
    expect((await store.get(ORG, "linear"))?.accessToken).toBe("legacy");
    expect(f.calls).toHaveLength(0);
  });
});
