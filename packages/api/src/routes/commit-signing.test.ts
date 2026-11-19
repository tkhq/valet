import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc, type SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import type { GithubKeyType } from "@valet/plugin-turnkey/github-keys";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { pluginStore } from "../services/plugin-store.js";
import type { AppEnv } from "../env.js";
import { FRESH_SIGN_IN_REQUIRED, type GetCommitSigningResponse, type PostCommitSigningGithubCheckResponse } from "../wire/types.js";
import { buildCommitSigningRouter, ENROLL_FRESH_SIGN_IN_MS, freshSignInRefusal, parseEnrollBody, recentHistory, renderAllowedSigners } from "./commit-signing.js";

const attestation = {
  credentialId: "cred",
  clientDataJson: "{}",
  attestationObject: "ao",
  transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
};

describe("parseEnrollBody", () => {
  it("accepts the shape the browser posts", () => {
    expect(parseEnrollBody({ challenge: "c", attestation, authenticatorName: "My key" })).toEqual({
      authenticatorName: "My key",
      challenge: "c",
      attestation,
    });
  });

  it("refuses a missing field or an unknown transport", () => {
    expect(parseEnrollBody({ challenge: "c" })).toBeNull();
    expect(parseEnrollBody({ challenge: "c", attestation: { ...attestation, transports: ["usb"] } })).toBeNull();
    expect(parseEnrollBody({ challenge: 1, attestation })).toBeNull();
    expect(parseEnrollBody(null)).toBeNull();
  });
});

describe("renderAllowedSigners", () => {
  const row: SigningKeyIndexDoc = {
    userId: "u1",
    userEmail: "dev@example.com",
    orgId: "o1",
    sessionId: "s1",
    userKey: "k",
    fingerprint: "SHA256:x",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG",
    githubKeyId: 1,
    notBefore: Date.parse("2026-09-12T10:00:00Z"),
    notAfter: Date.parse("2026-09-12T12:00:00Z"),
    status: "closed",
  };

  it("renders one line per key with its window, and the email as principal", () => {
    expect(renderAllowedSigners([row])).toBe(
      'dev@example.com valid-after="20260912100000Z",valid-before="20260912120000Z" ' +
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG\n",
    );
  });

  it("writes a file ssh-keygen accepts inside the window and refuses after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "allowed-signers-"));
    try {
      const key = join(dir, "key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      const payload = join(dir, "payload");
      writeFileSync(payload, "commit");
      execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-n", "git", "-f", key, payload]);
      const publicKey = readFileSync(`${key}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
      const allowed = join(dir, "allowed_signers");
      writeFileSync(allowed, renderAllowedSigners([{ ...row, publicKey }]));
      const verify = (at: string) =>
        execFileSync(
          "ssh-keygen",
          ["-Y", "verify", "-n", "git", "-f", allowed, "-I", "dev@example.com", "-s", `${payload}.sig`, "-Overify-time=" + at],
          { input: "commit", stdio: ["pipe", "pipe", "pipe"] },
        );
      expect(() => verify("20260912110000Z")).not.toThrow();
      expect(() => verify("20260912130000Z")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a user principal and renders nothing for no keys", () => {
    const { userEmail: _drop, ...noEmail } = row;
    expect(renderAllowedSigners([noEmail]).startsWith("user:u1@valet ")).toBe(true);
    expect(renderAllowedSigners([])).toBe("");
  });
});

describe("freshSignInRefusal", () => {
  it("allows a recent browser sign-in and the dev stub, and refuses an old one", () => {
    const now = 10 * ENROLL_FRESH_SIGN_IN_MS;
    expect(freshSignInRefusal({ sessionCreatedAt: now - 60_000 }, now)).toBeNull();
    expect(freshSignInRefusal({}, now)).toBeNull();
    expect(freshSignInRefusal({ sessionCreatedAt: now - ENROLL_FRESH_SIGN_IN_MS - 1 }, now)).toContain("sign in again");
  });
});

describe("recentHistory", () => {
  it("lists the newest signing first and keeps at most 50", () => {
    const row = (signedAt: number) => ({
      repo: "a/b",
      branch: "x",
      commits: [{ old: "1", new: "2" }],
      signedAt,
      activityIds: ["act"],
      sessionId: "s",
      threadId: "t",
    });
    const rows = recentHistory(Array.from({ length: 60 }, (_, i) => row(i)));
    expect(rows).toHaveLength(50);
    expect(rows[0]?.signedAt).toBe(59);
    expect(rows[49]?.signedAt).toBe(10);
  });
});

describe("commit signing routes", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  const CONFIG = { organizationId: "parent", apiPublicKey: "02aa", apiPrivateKey: "bb", apiBaseUrl: "https://turnkey.test", assurance: "presence" as const };
  const ENROLLMENT: EnrollmentDoc = {
    subOrgId: "sub-1",
    passkeyUserId: "passkey-user",
    mode: "presence",
    signingKey: { privateKeyId: "pk-1", publicKeyHex: "00", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:x", activityId: "a0" },
    signingTagId: "ktag",
    createdAt: 1,
  };

  async function mount(opts: { sessionCreatedAt?: number; keyType?: GithubKeyType; enrolled?: boolean }) {
    api = await bootTestApi();
    const providers = api.providers;
    if (opts.enrolled) await pluginStore(providers.db, PLUGIN_NAME).user("local-user").put(COLLECTIONS.enrollment, DEFAULT_KEY, ENROLLMENT);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("providers", providers);
      c.set("user", {
        id: "local-user", email: "local@dev", role: "admin", orgId: "local-org",
        ...(opts.sessionCreatedAt !== undefined ? { sessionCreatedAt: opts.sessionCreatedAt } : {}),
      });
      await next();
    });
    app.route("/", buildCommitSigningRouter({
      config: () => CONFIG,
      githubLogin: async () => "octo",
      keyType: async () => opts.keyType ?? null,
    }));
    return app;
  }

  it("reports when the sign-in becomes too old to start setup", async () => {
    const app = await mount({ sessionCreatedAt: 1_000 });
    const body = (await (await app.request("/")).json()) as GetCommitSigningResponse;
    expect(body.freshSignInUntil).toBe(1_000 + ENROLL_FRESH_SIGN_IN_MS);
  });

  it("refuses setup on an old sign-in with a code the web can act on", async () => {
    const app = await mount({ sessionCreatedAt: Date.now() - ENROLL_FRESH_SIGN_IN_MS - 1 });
    const res = await app.request("/enroll", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: FRESH_SIGN_IN_REQUIRED, error: expect.stringContaining("sign in again") });
  });

  it("names an authentication key on GitHub so the person can add it again as a signing key", async () => {
    const app = await mount({ enrolled: true, keyType: "authentication" });
    const body = (await (await app.request("/github-check", { method: "POST" })).json()) as PostCommitSigningGithubCheckResponse;
    expect(body).toEqual({ connected: true, login: "octo", listed: false, listedAsAuthentication: true });
  });

  it("reports a signing key as listed", async () => {
    const app = await mount({ enrolled: true, keyType: "signing" });
    const body = (await (await app.request("/github-check", { method: "POST" })).json()) as PostCommitSigningGithubCheckResponse;
    expect(body).toEqual({ connected: true, login: "octo", listed: true });
  });
});
