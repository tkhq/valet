import { describe, expect, it } from "vitest";
import type { DecisionGateRequest, DecisionResolution } from "@valet/engine";
import { gitObjectId, planCommitChain } from "../commits.js";
import { NOT_CONFIGURED_MESSAGE } from "../config.js";
import { SIGNING_KEY_MISSING_MESSAGE } from "../github-keys.js";
import { presenceStepsKey, signingContextOf } from "../presence.js";
import {
  COLLECTIONS,
  CURRENT_KEY,
  DEFAULT_KEY,
  type EnrollmentDoc,
  type PresenceStepsDoc,
  type SigningKeyDoc,
  type SigningKeyIndexDoc,
} from "../store.js";
import {
  PUBLIC_HEX,
  SIGNED_1_SHA,
  UNSIGNED_1,
  UNSIGNED_1_SHA,
  UNSIGNED_2,
  UNSIGNED_2_SHA,
  signWithTestKey,
} from "../test-helpers/commit-fixtures.js";
import { fakeContext, fakeGithub, fakeTurnkey, memoryPluginStore } from "../test-helpers/fakes.js";
import {
  buildTurnkeyActionPlugin,
  NO_GITHUB_MESSAGE,
  NOT_ENROLLED_MESSAGE,
  PRESENCE_MODE_MESSAGE,
  REENROLL_MESSAGE,
  REJECTED_MESSAGE,
  SESSION_MODE_MESSAGE,
} from "./actions.js";

const ENV = {
  VALET_TURNKEY_ORGANIZATION_ID: "parent-org",
  VALET_TURNKEY_API_PUBLIC_KEY: "02aa",
  VALET_TURNKEY_API_PRIVATE_KEY: "bb",
};
const NOW = Date.parse("2026-09-12T10:00:00Z");
const KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVmz5Xwr6nl6ySk7DPrC7gAbwoQ1aEX2QLe7Vc3MjA2";

const PRESENCE: EnrollmentDoc = {
  subOrgId: "suborg-1",
  passkeyUserId: "passkey-user",
  mode: "presence",
  signingKey: { privateKeyId: "pk-person", publicKeyHex: PUBLIC_HEX, publicKey: KEY_LINE, fingerprint: "SHA256:person", activityId: "act-0" },
  signingTagId: "ktag-1",
  createdAt: 1,
};
const SESSION: EnrollmentDoc = { ...PRESENCE, mode: "session", agentUserId: "agent-user", agentTagId: "utag-1", policyId: "policy-1" };

/** A repository with two unsigned commits on `feature`, answering the git commands sign_commits runs. */
function repoExec(refs: Map<string, string>) {
  return (command: string) => {
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
    if (command.endsWith("git rev-parse --show-object-format")) return ok("sha1\n");
    if (command.endsWith("git rev-parse --abbrev-ref HEAD")) return ok("feature\n");
    if (command.endsWith("git rev-parse HEAD")) return ok(`${refs.get("feature")}\n`);
    if (command.includes("git rev-list")) return ok(`${UNSIGNED_1_SHA}\n${UNSIGNED_2_SHA}\n`);
    if (command.endsWith(`git cat-file commit ${UNSIGNED_1_SHA}`)) return ok(UNSIGNED_1);
    if (command.endsWith(`git cat-file commit ${UNSIGNED_2_SHA}`)) return ok(UNSIGNED_2);
    const write = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| git hash-object/.exec(command);
    if (write) return ok(`${gitObjectId(Buffer.from(write[1]!, "base64").toString("utf8"))}\n`);
    const update = /git update-ref 'refs\/heads\/feature' ([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(command);
    if (update) {
      refs.set("feature", update[1]!);
      return ok("");
    }
    return undefined;
  };
}

function setup(opts: { enrollment?: EnrollmentDoc | null; githubToken?: string | null; approve?: boolean; listed?: boolean } = {}) {
  const turnkey = fakeTurnkey();
  const github = fakeGithub();
  const store = memoryPluginStore();
  const refs = new Map([["feature", UNSIGNED_2_SHA]]);
  // Stands in for the api's passkey endpoint: signs each commit with the
  // test key, records the signatures, and resolves with presence evidence.
  const decision = async (req: DecisionGateRequest): Promise<DecisionResolution> => {
    if (opts.approve === false) return { actionId: "reject", resolvedBy: "user-1", resolvedAt: NOW };
    const signing = signingContextOf(req.context);
    if (!signing) return { actionId: "approve", resolvedBy: "user-1", resolvedAt: NOW };
    const signatures: Buffer[] = [];
    let plan = planCommitChain({ ...signing, signatures });
    while (plan.nextPayload) {
      signatures.push(signWithTestKey(plan.nextPayload));
      plan = planCommitChain({ ...signing, signatures });
    }
    const doc: PresenceStepsDoc = { signatures: signatures.map((s, i) => ({ activityId: `act-${i}`, signatureHex: s.toString("hex") })) };
    await store.session("session-1").put(COLLECTIONS.presenceSteps, presenceStepsKey(req.resumeKey ?? "", 1), doc);
    return {
      actionId: "approve",
      resolvedBy: "user-1",
      resolvedAt: NOW,
      assurance: "presence",
      approval: {
        id: "apr_1",
        approved_at: "2026-09-12T10:00:00.000Z",
        approved_until: "2026-09-12T10:00:00.000Z",
        state: {
          iss: "turnkey",
          organization_id: "suborg-1",
          amr: ["pop", "user"],
          approver: { user_id: "passkey-user" },
          activities: doc.signatures.map((s) => ({ activity_id: s.activityId, payload_sha256: "", approved_at: "2026-09-12T10:00:00.000Z" })),
        },
      },
      gateOrdinal: 1,
    };
  };
  const ctx = fakeContext({ pluginStore: store, githubToken: opts.githubToken, decision, exec: repoExec(refs) });
  const plugin = buildTurnkeyActionPlugin({
    turnkey: () => turnkey,
    github: () => github,
    keyListed: async () => opts.listed !== false,
    env: ENV,
    now: () => NOW,
  });
  const find = (id: string) => {
    const a = plugin.actions.find((x) => x.id === id);
    if (!a) throw new Error(`${id} missing`);
    return a;
  };
  const enroll = async () => {
    const doc = opts.enrollment === undefined ? PRESENCE : opts.enrollment;
    if (doc) await store.user("user-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, doc);
  };
  return { turnkey, github, store, ctx, refs, sign: find("turnkey.sign_commits"), request: find("turnkey.request_signing_key"), revoke: find("turnkey.revoke_signing_key"), enroll };
}

const signArgs = { repo: "tkhq/valet", branch: "feature", base: "origin/main" };
const scope = { repo: "tkhq/valet", branch: "valet/x", pr_number: 7 };

describe("turnkey.sign_commits", () => {
  it("opens a passkey gate, then writes the signed commits and moves the branch", async () => {
    const s = setup();
    await s.enroll();
    const res = await s.sign.execute(signArgs, s.ctx);
    expect(res.success).toBe(true);

    const gate = s.ctx.gates[0];
    expect(gate?.title).toBe("Sign 2 commits");
    expect(gate?.context).toMatchObject({
      assurance: "presence",
      presence: {
        kind: "git_commits",
        repo: "tkhq/valet",
        branch: "feature",
        commits: [
          { sha: UNSIGNED_1_SHA, subject: "first commit", author: "Valet Test <valet@example.com>" },
          { sha: UNSIGNED_2_SHA, subject: "second commit" },
        ],
      },
    });
    expect(gate?.actions?.[0]).toMatchObject({ id: "approve", approves: true });
    expect(s.ctx.execs.some((c) => c.includes("cd '/workspace/valet'"))).toBe(true);

    const head = s.refs.get("feature");
    expect(res.data).toMatchObject({ head, commits: [{ old: UNSIGNED_1_SHA }, { old: UNSIGNED_2_SHA, new: head }] });
    // The committer email is the account's noreply address, so the chain differs from the fixture's.
    expect(head).not.toBe(UNSIGNED_2_SHA);
    expect(head).not.toBe(SIGNED_1_SHA);
    expect(s.turnkey.calls).toHaveLength(0);
  });

  it("shows GitHub's view of a pushed commit and the sandbox's numstat for an unpushed one", async () => {
    const s = setup();
    await s.enroll();
    s.github.pushed.set(UNSIGNED_1_SHA, { url: "https://github.com/tkhq/valet/commit/x", additions: 3, deletions: 1, files: [{ path: "a.txt", additions: 3, deletions: 1 }] });
    const ctx = fakeContext({
      pluginStore: s.store,
      decision: async () => ({ actionId: "reject", resolvedBy: "user-1", resolvedAt: NOW }),
      exec: (c) => (c.includes("git diff-tree") ? { exitCode: 0, stdout: "2\t0\tb.txt\n-\t-\timg.png\n", stderr: "" } : repoExec(s.refs)(c)),
    });
    await s.sign.execute(signArgs, ctx);
    const view = ctx.gates[0]?.context?.presence as { commits: Array<Record<string, unknown>> };
    expect(view.commits[0]).toMatchObject({ source: "github", url: "https://github.com/tkhq/valet/commit/x", additions: 3, filesTotal: 1 });
    expect(view.commits[1]).toMatchObject({ source: "sandbox", additions: 2, deletions: 0, filesTotal: 2, files: [{ path: "b.txt" }, { path: "img.png" }] });
    expect(ctx.gates[0]?.dedupeKey).toBe("sign-commits:tkhq/valet:feature");
  });

  it("refuses a tag object presented as a commit, before opening a gate", async () => {
    const s = setup();
    await s.enroll();
    const tag = `object ${"a".repeat(40)}\ntype commit\ntag v1\ntagger T <t@x> 1 +0000\n\nrelease\n`;
    const tagSha = gitObjectId(tag);
    const ctx = fakeContext({
      pluginStore: s.store,
      exec: (c) =>
        c.includes("git rev-list") ? { exitCode: 0, stdout: `${tagSha}\n`, stderr: "" }
          : c.endsWith(`git cat-file commit ${tagSha}`) ? { exitCode: 0, stdout: tag, stderr: "" }
            : repoExec(s.refs)(c),
    });
    const res = await s.sign.execute(signArgs, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("not a plain git commit");
    expect(ctx.gates).toHaveLength(0);
  });

  it("refuses to write commits when a stored signature does not verify", async () => {
    const s = setup();
    await s.enroll();
    const ctx = fakeContext({
      pluginStore: s.store,
      exec: repoExec(s.refs),
      decision: async (req) => {
        const doc: PresenceStepsDoc = { signatures: [{ activityId: "a", signatureHex: "00".repeat(64) }, { activityId: "b", signatureHex: "00".repeat(64) }] };
        await s.store.session("session-1").put(COLLECTIONS.presenceSteps, presenceStepsKey(req.resumeKey ?? "", 1), doc);
        return { actionId: "approve", resolvedBy: "user-1", resolvedAt: NOW, assurance: "presence", gateOrdinal: 1 };
      },
    });
    const res = await s.sign.execute(signArgs, ctx);
    expect(res.error).toContain("does not match your signing key");
    expect(s.refs.get("feature")).toBe(UNSIGNED_2_SHA);
  });

  it("refuses more than 10 commits with the fix", async () => {
    const s = setup();
    await s.enroll();
    const many = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(40, "0")).join("\n");
    const ctx = fakeContext({
      pluginStore: s.store,
      exec: (c) => (c.includes("git rev-list") ? { exitCode: 0, stdout: many, stderr: "" } : repoExec(s.refs)(c)),
    });
    const res = await s.sign.execute(signArgs, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Squash them to 10 or fewer");
    expect(ctx.gates).toHaveLength(0);
  });

  it("refuses when the key is not on GitHub, before opening a gate", async () => {
    const s = setup({ listed: false });
    await s.enroll();
    expect(await s.sign.execute(signArgs, s.ctx)).toEqual({ success: false, error: SIGNING_KEY_MISSING_MESSAGE });
    expect(s.ctx.gates).toHaveLength(0);
  });

  it("names the fix for a missing, old, or session-mode enrollment", async () => {
    const none = setup({ enrollment: null });
    expect(await none.sign.execute(signArgs, none.ctx)).toEqual({ success: false, error: NOT_ENROLLED_MESSAGE });
    const { signingKey: _drop, ...old } = PRESENCE;
    const legacy = setup({ enrollment: old });
    await legacy.enroll();
    expect(await legacy.sign.execute(signArgs, legacy.ctx)).toEqual({ success: false, error: REENROLL_MESSAGE });
    const session = setup({ enrollment: SESSION });
    await session.enroll();
    expect(await session.sign.execute(signArgs, session.ctx)).toEqual({ success: false, error: SESSION_MODE_MESSAGE });
  });

  it("leaves the branch alone when the user rejects", async () => {
    const s = setup({ approve: false });
    await s.enroll();
    expect(await s.sign.execute(signArgs, s.ctx)).toEqual({ success: false, error: REJECTED_MESSAGE });
    expect(s.refs.get("feature")).toBe(UNSIGNED_2_SHA);
  });

  it("reuses an approval for the same commits after the sandbox loses the signed branch", async () => {
    const s = setup();
    await s.enroll();
    const first = await s.sign.execute(signArgs, s.ctx);
    expect(first.success).toBe(true);
    // A new sandbox: the branch is back at the pushed, unsigned head.
    s.refs.set("feature", UNSIGNED_2_SHA);
    const ctx = fakeContext({ pluginStore: s.store, exec: repoExec(s.refs) });
    const again = await s.sign.execute(signArgs, ctx);
    expect(again).toMatchObject({ success: true, data: { head: (first.data as { head: string }).head, reused: true } });
    expect(ctx.gates).toHaveLength(0);
    expect(s.refs.get("feature")).toBe((first.data as { head: string }).head);
  });

  it("opens a new gate when a stored approval no longer verifies against the key", async () => {
    const s = setup();
    await s.enroll();
    await s.sign.execute(signArgs, s.ctx);
    s.refs.set("feature", UNSIGNED_2_SHA);
    // The person set up again with a different key.
    await s.store.user("user-1").put(COLLECTIONS.enrollment, DEFAULT_KEY, {
      ...PRESENCE,
      signingKey: { ...PRESENCE.signingKey!, publicKeyHex: "11".repeat(32) },
    });
    const ctx = fakeContext({ pluginStore: s.store, exec: repoExec(s.refs), decision: async () => ({ actionId: "reject", resolvedBy: "user-1", resolvedAt: NOW }) });
    const res = await s.sign.execute(signArgs, ctx);
    expect(ctx.gates).toHaveLength(1);
    expect(res).toEqual({ success: false, error: REJECTED_MESSAGE });
    expect(s.refs.get("feature")).toBe(UNSIGNED_2_SHA);
  });

  it("does not reuse an approval from another session", async () => {
    const s = setup();
    await s.enroll();
    await s.sign.execute(signArgs, s.ctx);
    s.refs.set("feature", UNSIGNED_2_SHA);
    const ctx = fakeContext({ sessionId: "session-2", pluginStore: s.store, exec: repoExec(s.refs), decision: async () => ({ actionId: "reject", resolvedBy: "user-1", resolvedAt: NOW }) });
    await s.sign.execute(signArgs, ctx);
    expect(ctx.gates).toHaveLength(1);
  });

  it("refuses an approval without presence evidence", async () => {
    const s = setup();
    await s.enroll();
    const ctx = fakeContext({ pluginStore: s.store, exec: repoExec(s.refs) });
    const res = await s.sign.execute(signArgs, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("no passkey signatures");
    expect(s.refs.get("feature")).toBe(UNSIGNED_2_SHA);
  });
});

describe("turnkey.request_signing_key (session mode)", () => {
  it("gates, records the window with the person's key, and turns signing on without touching GitHub", async () => {
    const s = setup({ enrollment: SESSION });
    await s.enroll();
    const res = await s.request.execute(scope, s.ctx);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ fingerprint: "SHA256:person", private_key_id: "pk-person", not_after: "2026-09-12T12:00:00.000Z" });
    expect(s.ctx.gates[0]?.body).toContain("Sign commits in tkhq/valet, branch valet/x (pull request #7), valid for 2 h?");
    expect(s.turnkey.calls.map((c) => c.op)).toEqual(["createApiKey"]);
    expect(s.turnkey.calls[0]?.args).toMatchObject({ subOrgId: "suborg-1", userId: "agent-user", expirationSeconds: 120 * 60 });
    const current = await s.store.session("session-1").get<SigningKeyDoc>(COLLECTIONS.signingKeys, CURRENT_KEY);
    expect(current?.doc).toMatchObject({ status: "active", turnkeyPrivateKeyId: "pk-person", notAfter: NOW + 120 * 60_000 });
    expect(current?.doc).not.toHaveProperty("githubKeyId");
    const index = await s.store.global().list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex);
    expect(index.items[0]?.doc).toMatchObject({ publicKey: KEY_LINE, status: "active" });
    expect(s.ctx.execs.some((c) => c.includes("TURNKEY_PRIVATE_KEY_ID=pk-person"))).toBe(true);
  });

  it("points a presence-mode account at sign_commits", async () => {
    const s = setup();
    await s.enroll();
    expect(await s.request.execute(scope, s.ctx)).toEqual({ success: false, error: PRESENCE_MODE_MESSAGE });
  });

  it("names the fix when not configured or GitHub is not connected", async () => {
    const s = setup({ enrollment: SESSION });
    const plugin = buildTurnkeyActionPlugin({ env: {} });
    const request = plugin.actions.find((a) => a.id === "turnkey.request_signing_key");
    expect(await request?.execute(scope, s.ctx)).toEqual({ success: false, error: NOT_CONFIGURED_MESSAGE });
    const noGithub = setup({ enrollment: SESSION, githubToken: null });
    await noGithub.enroll();
    expect(await noGithub.request.execute(scope, noGithub.ctx)).toEqual({ success: false, error: NO_GITHUB_MESSAGE });
  });
});

describe("turnkey.revoke_signing_key", () => {
  it("marks the window revoked, deletes the session key, and turns signing off", async () => {
    const s = setup({ enrollment: SESSION });
    await s.enroll();
    await s.request.execute(scope, s.ctx);
    const res = await s.revoke.execute({ fingerprint: "SHA256:person" }, s.ctx);
    expect(res).toEqual({ success: true, data: { fingerprint: "SHA256:person", status: "revoked" } });
    expect(await s.store.session("session-1").get(COLLECTIONS.signingKeys, CURRENT_KEY)).toBeNull();
    expect(s.ctx.execs.at(-1)).toContain("--unset commit.gpgsign");
    expect(s.turnkey.calls.map((c) => c.op)).toEqual(["createApiKey", "deleteApiKeys"]);
  });

  it("refuses a fingerprint with no open window", async () => {
    const s = setup();
    const res = await s.revoke.execute({ fingerprint: "SHA256:nope" }, s.ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("SHA256:nope");
  });
});
