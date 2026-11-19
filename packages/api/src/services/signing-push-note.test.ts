/**
 * Sign by default: the note after a successful `git push` depends on whether
 * the person who asked set up commit signing, and on who runs the turn.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GitPushTurn } from "@valet/engine";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc, type SigningHistoryDoc } from "@valet/plugin-turnkey/store";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { pluginStore } from "./plugin-store.js";
import { setupNote, signingPushNote, signRequestNote } from "./signing-push-note.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const ENV = { VALET_TURNKEY_ORGANIZATION_ID: "org", VALET_TURNKEY_API_PUBLIC_KEY: "02aa", VALET_TURNKEY_API_PRIVATE_KEY: "bb" };
const ENROLLMENT: EnrollmentDoc = {
  subOrgId: "sub-1",
  passkeyUserId: "passkey-user",
  mode: "presence",
  signingKey: { privateKeyId: "pk-1", publicKeyHex: "00", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:x", activityId: "a0" },
  signingTagId: "ktag",
  createdAt: 1,
};
const TURN: GitPushTurn = { userId: "person-1", orgId: "org-1", sessionId: "s-1", threadId: "t-1" };
const PUSH = { repo: "acme/app", branch: "feature", headSha: "5d6e7f8" };

async function setup() {
  api = await bootTestApi();
  const db = api.providers.db;
  return { db, store: pluginStore(db, PLUGIN_NAME), note: signingPushNote(db, "https://valet.example/", ENV) };
}

describe("signing push note", () => {
  it("asks an enrolled person's turn to sign the pushed commits", async () => {
    const { store, note } = await setup();
    await store.user("person-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
    expect(await note(PUSH, TURN)).toBe(signRequestNote(PUSH));
    expect(signRequestNote(PUSH)).toContain('params={"repo":"acme/app","branch":"feature",');
    expect(signRequestNote(PUSH)).toContain("git push --force-with-lease origin feature");
  });

  it("adds nothing once the pushed head is the one this session signed", async () => {
    const { store, note } = await setup();
    await store.user("person-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
    const history: SigningHistoryDoc = {
      repo: "acme/app", branch: "feature", commits: [{ old: "1a2b3c4aaaa", new: "5d6e7f8bbbb" }],
      signedAt: 1, activityIds: ["act"], sessionId: "s-1", threadId: "t-1",
    };
    await store.user("person-1").put(COLLECTIONS.signingHistory, "s-1:chain", history);
    expect(await note(PUSH, TURN)).toBeUndefined();
    expect(await note({ ...PUSH, headSha: "9999999" }, TURN)).toBe(signRequestNote({ ...PUSH, headSha: "9999999" }));
  });

  it("names setup once per session for a person who has not set up signing", async () => {
    const { note } = await setup();
    expect(await note(PUSH, TURN)).toBe(setupNote("https://valet.example/"));
    expect(setupNote("https://valet.example/")).toContain("https://valet.example/integrations");
    expect(await note(PUSH, TURN)).toBeUndefined();
    expect(await note(PUSH, { ...TURN, sessionId: "s-2" })).toBe(setupNote("https://valet.example/"));
  });

  it("adds nothing when no person waits, a team or channel sender runs the turn, or signing is not configured", async () => {
    const { db, store, note } = await setup();
    await store.user("person-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
    expect(await note(PUSH, { ...TURN, unattended: true })).toBeUndefined();
    expect(await note(PUSH, { ...TURN, externalSender: true })).toBeUndefined();
    expect(await note(PUSH, { ...TURN, userId: "team:team-1" })).toBeUndefined();
    expect(await signingPushNote(db, undefined, {})(PUSH, TURN)).toBeUndefined();
  });
});
