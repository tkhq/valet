/**
 * Signed pull requests: the org rule, and the instruction the model reads
 * when a commit on the branch is not Verified.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc } from "@valet/plugin-turnkey/store";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgs } from "../schema/index.js";
import { pluginStore } from "./plugin-store.js";
import { SIGNED_PULL_REQUESTS_RULE, signedPullRequestRequirement } from "./signed-pull-requests.js";

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
const TURN = { userId: "person-1", orgId: "local-org" };

async function setup(required: boolean) {
  api = await bootTestApi();
  const db = api.providers.db;
  await db.update(orgs).set({ requireSignedPullRequests: required }).where(eq(orgs.id, "local-org"));
  return { db, rule: signedPullRequestRequirement(db, "https://valet.example/", ENV) };
}

describe("signed pull request rule", () => {
  it("has no rule when the org does not require signed commits", async () => {
    const { rule } = await setup(false);
    expect(await rule(TURN)).toBeUndefined();
  });

  it("tells an enrolled person's turn to sign, push, and open the pull request again", async () => {
    const { db, rule } = await setup(true);
    await pluginStore(db, PLUGIN_NAME).user("person-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
    const text = await rule(TURN);
    expect(text).toContain(SIGNED_PULL_REQUESTS_RULE);
    expect(text).toContain("turnkey.sign_commits");
    expect(text).toContain("open the pull request again");
  });

  it("names a signing window for a session-mode enrollment", async () => {
    const { db, rule } = await setup(true);
    await pluginStore(db, PLUGIN_NAME).user("person-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, { ...ENROLLMENT, mode: "session" });
    expect(await rule(TURN)).toContain("turnkey.request_signing_key");
  });

  it("tells the model not to open the pull request when the person has not set up signing", async () => {
    const { rule } = await setup(true);
    const text = await rule(TURN);
    expect(text).toContain("has not set up commit signing. Do not open the pull request.");
    expect(text).toContain("https://valet.example/integrations");
  });

  it("tells a run with no person to report the branch", async () => {
    const { rule } = await setup(true);
    for (const turn of [{ ...TURN, unattended: true }, { ...TURN, externalSender: true }, { ...TURN, userId: "team:team-1" }]) {
      expect(await rule(turn)).toContain("No person can sign commits for this run. Do not open the pull request.");
    }
  });

  it("tells the model to ask an admin when signing is not configured", async () => {
    const { db } = await setup(true);
    expect(await signedPullRequestRequirement(db, undefined, {})(TURN)).toContain("ask an admin to configure commit signing");
  });
});
