import { describe, expect, it } from "vitest";
import { COLLECTIONS, type SigningKeyDoc, type SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import { memoryPluginStore } from "@valet/plugin-turnkey/test-helpers";
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
    turnkeySubOrgId: "sub",
    turnkeyPrivateKeyId: "pk",
    turnkeyCreateActivityId: "act",
    notBefore: index.notBefore,
    notAfter: index.notAfter ?? NOW,
    status: index.status,
    createdAt: index.notBefore,
  };
  return { index, user };
}

describe("sweepSigningKeysOnce", () => {
  it("closes both rows for a window past its end", async () => {
    const store = memoryPluginStore();
    const { index, user } = keyDocs();
    await store.global().put(COLLECTIONS.signingKeyIndex, "k1", index);
    await store.user("u1").put(COLLECTIONS.signingKeys, "k1", user);

    const result = await sweepSigningKeysOnce({ store, now: () => NOW });

    expect(result).toEqual({ checked: 1, closed: 1, failed: 0 });
    const closedIndex = await store.global().get<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, "k1");
    expect(closedIndex?.doc.status).toBe("closed");
    const closedUser = await store.user("u1").get<SigningKeyDoc>(COLLECTIONS.signingKeys, "k1");
    expect(closedUser?.doc).toMatchObject({ status: "closed", closedAt: NOW });
  });

  it("leaves open windows, closed rows, and enrollment keys with no window alone", async () => {
    const store = memoryPluginStore();
    const live = keyDocs({ userKey: "k2", notAfter: NOW + 60_000 });
    const done = keyDocs({ userKey: "k3", status: "closed" });
    const { notAfter: _drop, ...enrollmentIndex } = keyDocs({ userKey: "k4" }).index;
    await store.global().put(COLLECTIONS.signingKeyIndex, "k2", live.index);
    await store.global().put(COLLECTIONS.signingKeyIndex, "k3", done.index);
    await store.global().put(COLLECTIONS.signingKeyIndex, "k4", enrollmentIndex);

    const result = await sweepSigningKeysOnce({ store, now: () => NOW });
    expect(result).toEqual({ checked: 0, closed: 0, failed: 0 });
  });
});
