import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { TeamCredentialStore } from "./team-credential-store.js";

function makeStore(seed: Record<string, StoredCredential> = {}): CredentialStore {
  const map = new Map<string, StoredCredential>(Object.entries(seed));
  const key = (o: CredentialOwner, s: string) => `${o.type}:${o.id}:${s}`;
  return {
    async get(owner, service) {
      return map.get(key(owner, service)) ?? null;
    },
    async save(owner, service, cred) {
      map.set(key(owner, service), cred);
    },
    async delete(owner, service) {
      map.delete(key(owner, service));
    },
    async list() {
      return [];
    },
  };
}

describe("TeamCredentialStore", () => {
  const team = { type: "team" as const, id: "team_1" };
  const user = { type: "user" as const, id: "u1" };
  const org = { type: "org" as const, id: "org_1" };

  it("returns a direct team credential that holds a secret", async () => {
    const store = new TeamCredentialStore(makeStore({ "team:team_1:github": { type: "oauth2", accessToken: "team-tok" } }));
    await expect(store.get(team, "github")).resolves.toMatchObject({ accessToken: "team-tok" });
  });

  it("returns a 1Password reference row that has no secret yet", async () => {
    const store = new TeamCredentialStore(makeStore({
      "team:team_1:openai": { type: "api_key", metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } } },
    }));
    await expect(store.get(team, "openai")).resolves.toMatchObject({
      metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } },
    });
  });

  it("reads a secretless team row as absent, never as a route to a member's token", async () => {
    // A member's share lives in `credential_shares`, not on a team row, so a
    // stray `delegatedFrom` must not reach the member's credential.
    const store = new TeamCredentialStore(makeStore({
      "team:team_1:slack": { type: "oauth2", metadata: {} },
      "team:team_1:github": { type: "oauth2", metadata: { delegatedFrom: "u1" } },
      "user:u1:github": { type: "oauth2", accessToken: "user-tok" },
      "team:team_1:onepassword": { type: "service_account", metadata: { refs: ["op://Shared/Acme/credential"] } },
    }));
    await expect(store.get(team, "slack")).resolves.toBeNull();
    await expect(store.get(team, "github")).resolves.toBeNull();
    await expect(store.get(team, "onepassword")).resolves.toBeNull();
  });

  it("passes user and org reads through unchanged", async () => {
    const store = new TeamCredentialStore(makeStore({
      "user:u1:github": { type: "oauth2", accessToken: "user-tok" },
      "org:org_1:slack": { type: "bot_token", accessToken: "org-tok" },
    }));
    await expect(store.get(user, "github")).resolves.toMatchObject({ accessToken: "user-tok" });
    await expect(store.get(org, "slack")).resolves.toMatchObject({ accessToken: "org-tok" });
  });
});
