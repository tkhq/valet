import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import {
  CredentialReferenceBrokenError,
  TeamCredentialStore,
} from "./team-credential-store.js";

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
    const inner = makeStore({
      "team:team_1:github": { type: "oauth2", accessToken: "team-tok" },
    });
    const store = new TeamCredentialStore(inner, {
      isMember: async () => {
        throw new Error("direct rows must not check membership");
      },
    });
    await expect(store.get(team, "github")).resolves.toMatchObject({ accessToken: "team-tok" });
  });

  it("follows a reference to the delegator's current user token", async () => {
    const inner = makeStore({
      "team:team_1:github": { type: "oauth2", metadata: { delegatedFrom: "u1" } },
      "user:u1:github": { type: "oauth2", accessToken: "refreshed-user-tok" },
    });
    const seen: string[] = [];
    const store = new TeamCredentialStore(inner, {
      isMember: async (teamId, userId) => {
        seen.push(`${teamId}:${userId}`);
        return true;
      },
    });
    await expect(store.get(team, "github")).resolves.toMatchObject({
      accessToken: "refreshed-user-tok",
    });
    expect(seen).toEqual(["team_1:u1"]);
  });

  it("throws when the source user credential is gone", async () => {
    const inner = makeStore({
      "team:team_1:github": { type: "oauth2", metadata: { delegatedFrom: "u1" } },
    });
    const store = new TeamCredentialStore(inner, { isMember: async () => true });
    await expect(store.get(team, "github")).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    await expect(store.get(team, "github")).rejects.toThrow(/Reconnect github/);
  });

  it("throws when the delegator is no longer a team member", async () => {
    const inner = makeStore({
      "team:team_1:github": { type: "oauth2", metadata: { delegatedFrom: "u1" } },
      "user:u1:github": { type: "oauth2", accessToken: "still-there" },
    });
    const store = new TeamCredentialStore(inner, { isMember: async () => false });
    await expect(store.get(team, "github")).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    await expect(store.get(team, "github")).rejects.toThrow(/share it with the team again/);
  });

  it("treats an empty team stub as a miss so org fallback can run", async () => {
    const inner = makeStore({
      "team:team_1:slack": { type: "oauth2", metadata: {} },
    });
    const store = new TeamCredentialStore(inner, {
      isMember: async () => {
        throw new Error("empty stubs must not check membership");
      },
    });
    await expect(store.get(team, "slack")).resolves.toBeNull();
  });

  it("returns a team 1Password grant row that has no secret", async () => {
    const inner = makeStore({
      "team:team_1:onepassword": {
        type: "service_account",
        metadata: { refs: ["op://Shared/Acme/credential"] },
      },
    });
    const store = new TeamCredentialStore(inner, {
      isMember: async () => {
        throw new Error("grant rows must not check membership");
      },
    });
    await expect(store.get(team, "onepassword")).resolves.toMatchObject({
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
  });

  it("returns a 1Password reference row that has no secret yet", async () => {
    const inner = makeStore({
      "team:team_1:openai": {
        type: "api_key",
        metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } },
      },
    });
    const store = new TeamCredentialStore(inner, {
      isMember: async () => {
        throw new Error("1Password references must not check membership");
      },
    });
    await expect(store.get(team, "openai")).resolves.toMatchObject({
      metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } },
    });
  });

  it("passes user and org reads through unchanged", async () => {
    const inner = makeStore({
      "user:u1:github": { type: "oauth2", accessToken: "user-tok" },
      "org:org_1:slack": { type: "bot_token", accessToken: "org-tok" },
    });
    const store = new TeamCredentialStore(inner, {
      isMember: async () => {
        throw new Error("non-team reads must not check membership");
      },
    });
    await expect(store.get(user, "github")).resolves.toMatchObject({ accessToken: "user-tok" });
    await expect(store.get(org, "slack")).resolves.toMatchObject({ accessToken: "org-tok" });
  });
});
