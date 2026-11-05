import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  CURRENT_KEY,
  DEFAULT_KEY,
  type SigningKeyIndexDoc,
  type EnrollmentDoc,
  type SigningKeyDoc,
} from "../store.js";
import { GITHUB_PERMISSION_MESSAGE } from "../github-keys.js";
import { NOT_CONFIGURED_MESSAGE } from "../config.js";
import {
  EXPECTED_FINGERPRINT,
  EXPECTED_LINE,
  fakeContext,
  fakeGithub,
  fakeTurnkey,
  memoryPluginStore,
} from "../test-helpers/fakes.js";
import { buildTurnkeyActionPlugin, NOT_ENROLLED_MESSAGE, NO_GITHUB_MESSAGE, REJECTED_MESSAGE } from "./actions.js";

const ENV = {
  VALET_TURNKEY_ORGANIZATION_ID: "parent-org",
  VALET_TURNKEY_API_PUBLIC_KEY: "02aa",
  VALET_TURNKEY_API_PRIVATE_KEY: "bb",
};

const ENROLLMENT: EnrollmentDoc = {
  subOrgId: "suborg-1",
  passkeyUserId: "passkey-user",
  agentUserId: "agent-user",
  agentTagId: "utag-1",
  signingTagId: "ktag-1",
  policyId: "policy-1",
  createdAt: 1,
};

const NOW = Date.parse("2026-09-12T10:00:00Z");

function setup(opts: { enrolled?: boolean; githubToken?: string | null; approve?: boolean } = {}) {
  const turnkey = fakeTurnkey();
  const github = fakeGithub();
  const store = memoryPluginStore();
  const ctx = fakeContext({
    pluginStore: store,
    githubToken: opts.githubToken,
    decision: async () => ({
      actionId: opts.approve === false ? "reject" : "approve",
      resolvedBy: "user-1",
      resolvedAt: NOW,
    }),
  });
  const plugin = buildTurnkeyActionPlugin({ turnkey: () => turnkey, github: () => github, env: ENV, now: () => NOW });
  const request = plugin.actions.find((a) => a.id === "turnkey.request_signing_key");
  const revoke = plugin.actions.find((a) => a.id === "turnkey.revoke_signing_key");
  if (!request || !revoke) throw new Error("actions missing");
  const enroll = async () => {
    if (opts.enrolled !== false) await store.user("user-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
  };
  return { turnkey, github, store, ctx, plugin, request, revoke, enroll };
}

const scope = { repo: "tkhq/valet", branch: "valet/x", pr_number: 7 };

describe("turnkey.request_signing_key", () => {
  it("gates, creates the key, registers it on GitHub, records it, and turns signing on", async () => {
    const s = setup();
    await s.enroll();
    const res = await s.request.execute(scope, s.ctx);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      fingerprint: EXPECTED_FINGERPRINT,
      private_key_id: "pk-1",
      not_after: "2026-09-12T12:00:00.000Z",
    });

    // The gate carried the exact scope.
    expect(s.ctx.gates).toHaveLength(1);
    expect(s.ctx.gates[0]?.body).toContain("Sign commits in tkhq/valet, branch valet/x (pull request #7), valid for 2 h?");

    // Turnkey: one Ed25519 key with the signing tag, in the user's sub-organization.
    expect(s.turnkey.calls.map((c) => c.op)).toEqual(["createSigningKey"]);
    expect(s.turnkey.calls[0]?.args).toMatchObject({ subOrgId: "suborg-1", tagIds: ["ktag-1"] });

    // GitHub: the OpenSSH line under a title that names the session and expiry.
    const [registered] = [...s.github.keys.values()];
    expect(registered).toEqual({
      title: "valet session session-1 tkhq/valet#7 until 2026-09-12T12:00:00.000Z",
      key: EXPECTED_LINE,
    });

    // Store: the user's history row and the session's current pointer.
    const current = await s.store.session("session-1").get<SigningKeyDoc>(COLLECTIONS.signingKeys, CURRENT_KEY);
    expect(current?.doc).toMatchObject({
      status: "active",
      fingerprint: EXPECTED_FINGERPRINT,
      githubKeyId: 100,
      turnkeyPrivateKeyId: "pk-1",
      notBefore: NOW,
      notAfter: NOW + 120 * 60_000,
      gateId: "gate-1",
    });
    const history = await s.store.user("user-1").list<SigningKeyDoc>(COLLECTIONS.signingKeys);
    expect(history.items).toHaveLength(1);
    const index = await s.store.global().list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex);
    expect(index.items).toHaveLength(1);
    expect(index.items[0]?.doc).toMatchObject({
      userId: "user-1",
      userKey: history.items[0]?.key,
      githubKeyId: 100,
      status: "active",
    });

    // Sandbox: the key id for valet-sign, then git pointed at the public key.
    expect(s.ctx.execs.some((c) => c.includes("TURNKEY_PRIVATE_KEY_ID") && c.includes("'pk-1'"))).toBe(true);
    expect(s.ctx.execs.some((c) => c.includes(`user.signingkey 'key::${EXPECTED_LINE}'`) && c.includes("commit.gpgsign true"))).toBe(
      true,
    );
  });

  it("does nothing when the user rejects", async () => {
    const s = setup({ approve: false });
    await s.enroll();
    const res = await s.request.execute(scope, s.ctx);
    expect(res).toEqual({ success: false, error: REJECTED_MESSAGE });
    expect(s.turnkey.calls).toHaveLength(0);
    expect(s.github.keys.size).toBe(0);
    expect(s.ctx.execs).toHaveLength(0);
  });

  it("names the fix when the deployment is not configured", async () => {
    const s = setup();
    const plugin = buildTurnkeyActionPlugin({ turnkey: () => s.turnkey, github: () => s.github, env: {} });
    const request = plugin.actions.find((a) => a.id === "turnkey.request_signing_key");
    const res = await request?.execute(scope, s.ctx);
    expect(res).toEqual({ success: false, error: NOT_CONFIGURED_MESSAGE });
  });

  it("names the fix when the user has not enrolled", async () => {
    const s = setup({ enrolled: false });
    const res = await s.request.execute(scope, s.ctx);
    expect(res).toEqual({ success: false, error: NOT_ENROLLED_MESSAGE });
    expect(s.ctx.gates).toHaveLength(0);
  });

  it("names the fix when GitHub is not connected, before opening a gate", async () => {
    const s = setup({ githubToken: null });
    await s.enroll();
    const res = await s.request.execute(scope, s.ctx);
    expect(res).toEqual({ success: false, error: NO_GITHUB_MESSAGE });
    expect(s.ctx.gates).toHaveLength(0);
  });

  it("surfaces the GitHub App permission error and records nothing", async () => {
    const s = setup();
    await s.enroll();
    s.github.failCreateWith = new Error(GITHUB_PERMISSION_MESSAGE);
    await expect(s.request.execute(scope, s.ctx)).rejects.toThrow(/SSH signing keys/);
    const current = await s.store.session("session-1").get(COLLECTIONS.signingKeys, CURRENT_KEY);
    expect(current).toBeNull();
    expect(s.ctx.execs).toHaveLength(0);
  });

  it("clamps the window to 24 hours", async () => {
    const s = setup();
    await s.enroll();
    const res = await s.request.execute({ ...scope, window_minutes: 100_000 }, s.ctx);
    expect(res.data).toMatchObject({ not_after: "2026-09-13T10:00:00.000Z" });
    expect(s.ctx.gates[0]?.body).toContain("valid for 24 h?");
  });
});

describe("turnkey.revoke_signing_key", () => {
  it("removes the GitHub key, marks the row revoked, and turns signing off in its session", async () => {
    const s = setup();
    await s.enroll();
    await s.request.execute(scope, s.ctx);
    const res = await s.revoke.execute({ fingerprint: EXPECTED_FINGERPRINT }, s.ctx);
    expect(res).toEqual({ success: true, data: { fingerprint: EXPECTED_FINGERPRINT, status: "revoked" } });
    expect(s.github.keys.size).toBe(0);
    const history = await s.store.user("user-1").list<SigningKeyDoc>(COLLECTIONS.signingKeys);
    expect(history.items[0]?.doc).toMatchObject({ status: "revoked", closedAt: NOW });
    expect(await s.store.session("session-1").get(COLLECTIONS.signingKeys, CURRENT_KEY)).toBeNull();
    const index = await s.store.global().list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex);
    expect(index.items[0]?.doc.status).toBe("revoked");
    expect(s.ctx.execs.at(-1)).toContain("--unset commit.gpgsign");
  });

  it("refuses a fingerprint that is not the user's", async () => {
    const s = setup();
    const res = await s.revoke.execute({ fingerprint: "SHA256:nope" }, s.ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("SHA256:nope");
  });
});
