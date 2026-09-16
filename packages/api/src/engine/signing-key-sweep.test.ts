import { describe, expect, it } from "vitest";
import { COLLECTIONS, type SigningKeyDoc, type SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import { fakeGithub, memoryPluginStore } from "@valet/plugin-turnkey/test-helpers";
import { sweepSigningKeysOnce } from "./signing-key-sweep.js";

const NOW = Date.parse("2026-09-12T12:30:00Z");

function keyDocs(overrides: Partial<SigningKeyIndexDoc> = {}) {
  const index: SigningKeyIndexDoc = {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    userKey: "k1",
    fingerprint: "SHA256:a",
    publicKey: "ssh-ed25519 AAAA",
    githubKeyId: 100,
    notBefore: NOW - 3 * 60 * 60_000,
    notAfter: NOW - 60 * 60_000,
    status: "active",
    ...overrides,
  };
  const user: SigningKeyDoc = {
    sessionId: index.sessionId,
    userId: index.userId,
    orgId: index.orgId,
    repo: "a/b",
    branch: "x",
    fingerprint: index.fingerprint,
    publicKey: index.publicKey,
    githubKeyId: index.githubKeyId,
    turnkeySubOrgId: "sub",
    turnkeyPrivateKeyId: "pk",
    turnkeyCreateActivityId: "act",
    notBefore: index.notBefore,
    notAfter: index.notAfter,
    status: index.status,
    createdAt: index.notBefore,
  };
  return { index, user };
}

// The sweep resolves the user's GitHub token through `resolveUserApiToken`
// in production. These tests replace that seam and the store; the token
// lookup itself is exercised by the github-tokens suite.
function deps(store: ReturnType<typeof memoryPluginStore>, github: ReturnType<typeof fakeGithub>, token: string | null) {
  return { store, resolveToken: async () => token, github: () => github, now: () => NOW };
}

describe("sweepSigningKeysOnce", () => {
  it("removes the GitHub key and closes both rows for a key past its window", async () => {
    const store = memoryPluginStore();
    const github = fakeGithub();
    github.keys.set(100, { title: "t", key: "k" });
    const { index, user } = keyDocs();
    await store.global().put(COLLECTIONS.signingKeyIndex, "k1", index);
    await store.user("u1").put(COLLECTIONS.signingKeys, "k1", user);

    const result = await sweepSigningKeysOnce(deps(store, github, "gh-token"));

    expect(result).toEqual({ checked: 1, closed: 1, failed: 0 });
    expect(github.keys.has(100)).toBe(false);
    const closedIndex = await store.global().get<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, "k1");
    expect(closedIndex?.doc.status).toBe("closed");
    const closedUser = await store.user("u1").get<SigningKeyDoc>(COLLECTIONS.signingKeys, "k1");
    expect(closedUser?.doc).toMatchObject({ status: "closed", closedAt: NOW });
  });

  it("leaves keys inside their window and keys already closed alone", async () => {
    const store = memoryPluginStore();
    const github = fakeGithub();
    const live = keyDocs({ userKey: "k2", notAfter: NOW + 60_000 });
    const done = keyDocs({ userKey: "k3", status: "closed" });
    await store.global().put(COLLECTIONS.signingKeyIndex, "k2", live.index);
    await store.global().put(COLLECTIONS.signingKeyIndex, "k3", done.index);

    const result = await sweepSigningKeysOnce(deps(store, github, "gh-token"));
    expect(result).toEqual({ checked: 0, closed: 0, failed: 0 });
  });

  it("keeps the row active for the next tick when the user has no GitHub token", async () => {
    const store = memoryPluginStore();
    const github = fakeGithub();
    const { index, user } = keyDocs();
    await store.global().put(COLLECTIONS.signingKeyIndex, "k1", index);
    await store.user("u1").put(COLLECTIONS.signingKeys, "k1", user);

    const result = await sweepSigningKeysOnce(deps(store, github, null));
    expect(result).toEqual({ checked: 1, closed: 0, failed: 1 });
    const still = await store.global().get<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, "k1");
    expect(still?.doc.status).toBe("active");
  });
});
