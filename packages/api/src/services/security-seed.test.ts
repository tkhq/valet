import { describe, expect, it, vi } from "vitest";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "./onepassword.js";
import {
  preflightCredentials,
  seedSecurityReview,
  SecurityCredentialPreflightError,
  type RepoFileReader,
  type SecurityConfigCredentialDecl,
} from "./security-seed.js";

// The seed reads the repo through an injected `RepoFileReader`, so these tests
// never touch `source-service` and never depend on a `vi.mock` of it. The api
// vitest config runs with `isolate: false`: a sibling suite that imports
// `security-seed` first binds it to the real reader, and a module mock made
// later in this file cannot rebind that closure. Passing the reader in is
// order-independent.
function repoFiles(securityYaml: string | null): RepoFileReader {
  return {
    resolveApiTokenOrNull: async () => null,
    fetchRepoFile: async () => securityYaml,
  };
}

const REPO_CREDENTIALS_YAML = `version: 1
credentials:
  - label: admin
    kind: password
    env: ADMIN_PASSWORD
    reference: op://Sec/Admin/password
`;

const PASSWORD_DECL: SecurityConfigCredentialDecl = {
  label: "admin",
  kind: "password",
  env: "ADMIN_PASSWORD",
  reference: "op://Sec/Admin/password",
};

function onePasswordStub(
  resolveReference: OnePasswordService["resolveReference"],
): Pick<OnePasswordService, "resolveReference"> {
  return { resolveReference };
}

describe("preflightCredentials", () => {
  it("refuses when the ref does not resolve (kind=no_token)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("no token", "no_token")),
    );
    await expect(preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "no_token", label: "admin", ref: "op://Sec/Admin/password" });
  });

  it("refuses when personal vault is disabled (kind=disabled)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("disabled", "disabled")),
    );
    await expect(
      preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1", ownerType: "user" }, onePassword),
    ).rejects.toMatchObject({ reason: "disabled" });
  });

  it("refuses when 1Password refuses the request (kind=sdk)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("sdk refused", "sdk")),
    );
    await expect(preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "sdk" });
  });

  it("refuses when no tried scope can read the item (kind=scope)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("scope refused", "scope")),
    );
    await expect(preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "scope" });
  });

  it("refuses when the item was deleted or renamed (kind=reference)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("not found", "reference")),
    );
    await expect(preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "reference", ref: "op://Sec/Admin/password" });
  });

  it("refuses when the reference matches more than one item (kind=ambiguous)", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("ambiguous", "ambiguous")),
    );
    await expect(preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "ambiguous" });
  });

  it("refuses a bad op:// grammar without ever calling 1Password", async () => {
    const resolveReference = vi.fn();
    const onePassword = onePasswordStub(resolveReference);
    const decl: SecurityConfigCredentialDecl = { ...PASSWORD_DECL, reference: "not-an-op-ref" };
    await expect(preflightCredentials([decl], { orgId: "org1", userId: "user1" }, onePassword))
      .rejects.toMatchObject({ reason: "reference", ref: "not-an-op-ref" });
    expect(resolveReference).not.toHaveBeenCalled();
  });

  it("refuses a shape failure with reason=shape_failed and never names the value", async () => {
    // The resolved value IS the sentinel, and it fails the cookie-jar shape
    // rule, so the assertion below tests the message against a string the
    // preflight actually held.
    const onePassword = onePasswordStub(vi.fn().mockResolvedValue("SENTINEL_9f3a"));
    const jarDecl: SecurityConfigCredentialDecl = {
      label: "jar",
      kind: "session",
      env: "COOKIE_JAR",
      reference: "op://Sec/Jar/cookies",
    };
    let caught: unknown;
    try {
      await preflightCredentials([jarDecl], { orgId: "org1", userId: "user1" }, onePassword);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecurityCredentialPreflightError);
    const err = caught as SecurityCredentialPreflightError;
    expect(err.reason).toBe("shape_failed");
    expect(err.message).not.toContain("SENTINEL_9f3a");
  });

  it("reports the org scope's reference error, not the personal scope's missing token", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (scope: OnePasswordScope) => {
        if (scope === "org") throw new OnePasswordAuthError("not found", "reference");
        throw new OnePasswordAuthError("no personal token", "no_token");
      }),
    );
    let caught: unknown;
    try {
      await preflightCredentials(
        [PASSWORD_DECL],
        { orgId: "org1", userId: "user1", ownerType: "user" },
        onePassword,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecurityCredentialPreflightError);
    const err = caught as SecurityCredentialPreflightError;
    // The last scope tried has no token, but the reference is what to fix.
    expect(err.reason).toBe("reference");
    expect(err.remedy).toMatch(/Update the reference/);
    expect(err.remedy).not.toMatch(/Connect a token/);
  });

  it("checks headerToken length, mtls PEM marker, and toolAuth JSON shape", async () => {
    const shortToken = onePasswordStub(vi.fn().mockResolvedValue("short"));
    await expect(
      preflightCredentials(
        [{ label: "hdr", kind: "headerToken", env: "HDR", reference: "op://v/i/f" }],
        { orgId: "org1", userId: "user1" },
        shortToken,
      ),
    ).rejects.toMatchObject({ reason: "shape_failed" });

    const badPem = onePasswordStub(vi.fn().mockResolvedValue("not a key"));
    await expect(
      preflightCredentials(
        [{ label: "cert", kind: "mtls", env: "KEY", reference: "op://v/i/f" }],
        { orgId: "org1", userId: "user1" },
        badPem,
      ),
    ).rejects.toMatchObject({ reason: "shape_failed" });

    const badJson = onePasswordStub(vi.fn().mockResolvedValue("{not json"));
    await expect(
      preflightCredentials(
        [{ label: "bundle", kind: "toolAuth", env: "TOOL", reference: "op://v/i/f", refShape: "json" }],
        { orgId: "org1", userId: "user1" },
        badJson,
      ),
    ).rejects.toMatchObject({ reason: "shape_failed" });

    const goodJson = onePasswordStub(vi.fn().mockResolvedValue('{"a":1}'));
    const result = await preflightCredentials(
      [{ label: "bundle", kind: "toolAuth", env: "TOOL", reference: "op://v/i/f", refShape: "json" }],
      { orgId: "org1", userId: "user1" },
      goodJson,
    );
    expect(result).toEqual([{ label: "bundle", kind: "toolAuth", env: "TOOL", reference: "op://v/i/f", refShape: "json" }]);
  });

  it("refuses an mtls cert reference that does not resolve to a PEM certificate", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (_scope: OnePasswordScope, _ctx: OnePasswordCtx, reference: string) => {
        if (reference === "op://v/i/key") return "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
        return "not a cert";
      }),
    );
    await expect(
      preflightCredentials(
        [
          {
            label: "cert",
            kind: "mtls",
            env: "KEY",
            reference: "op://v/i/key",
            meta: { certRef: "op://v/i/cert" },
          },
        ],
        { orgId: "org1", userId: "user1" },
        onePassword,
      ),
    ).rejects.toMatchObject({ reason: "shape_failed" });
  });

  it("succeeds, drops the value, and returns only references", async () => {
    const onePassword = onePasswordStub(vi.fn().mockResolvedValue("SENTINEL_9f3a"));
    const result = await preflightCredentials([PASSWORD_DECL], { orgId: "org1", userId: "user1" }, onePassword);
    expect(result).toEqual([PASSWORD_DECL]);
    expect(JSON.stringify(result)).not.toContain("SENTINEL_9f3a");
  });

  it("skips to the next scope on no_token, but a configured team never falls back to org", async () => {
    const seen: OnePasswordScope[] = [];
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (scope: OnePasswordScope) => {
        seen.push(scope);
        if (scope === "team") throw new OnePasswordAuthError("team item missing", "reference");
        return "value";
      }),
    );
    await expect(
      preflightCredentials(
        [PASSWORD_DECL],
        { orgId: "org1", userId: "user1", ownerType: "team", teamId: "team1" },
        onePassword,
      ),
    ).rejects.toMatchObject({ reason: "reference" });
    // Team refused for a reason other than no_token: org must never be tried.
    expect(seen).toEqual(["team"]);
  });

  it("falls back from org (no_token) to personal for a user-owned engagement", async () => {
    const seen: OnePasswordScope[] = [];
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (scope: OnePasswordScope) => {
        seen.push(scope);
        if (scope === "org") throw new OnePasswordAuthError("no org token", "no_token");
        return "value123";
      }),
    );
    const result = await preflightCredentials(
      [PASSWORD_DECL],
      { orgId: "org1", userId: "user1", ownerType: "user" },
      onePassword,
    );
    expect(seen).toEqual(["org", "personal"]);
    expect(result).toEqual([PASSWORD_DECL]);
  });

  it("falls back from an org refusal to personal like the runtime broker", async () => {
    const seen: OnePasswordScope[] = [];
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (scope: OnePasswordScope) => {
        seen.push(scope);
        if (scope === "org") throw new OnePasswordAuthError("org refused", "sdk");
        return "value123";
      }),
    );
    await expect(
      preflightCredentials(
        [PASSWORD_DECL],
        { orgId: "org1", userId: "user1", ownerType: "user" },
        onePassword,
      ),
    ).resolves.toEqual([PASSWORD_DECL]);
    expect(seen).toEqual(["org", "personal"]);
  });

  it("is a no-op on an empty decl list", async () => {
    const resolveReference = vi.fn();
    const result = await preflightCredentials([], { orgId: "org1", userId: "user1" }, onePasswordStub(resolveReference));
    expect(result).toEqual([]);
    expect(resolveReference).not.toHaveBeenCalled();
  });
});

describe("seedSecurityReview credential preflight", () => {
  it("is a no-op when the request declares no credentials", async () => {
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      repoFiles: repoFiles(null),
    });
    expect(result.credentialsJson).toBeNull();
  });

  it("preflights repository credential declarations", async () => {
    const onePassword = onePasswordStub(vi.fn().mockResolvedValue("correct-horse"));
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      onePassword,
      repoFiles: repoFiles(REPO_CREDENTIALS_YAML),
    });
    expect(result.hasRepoConfig).toBe(true);
    expect(result.credentialsJson).toEqual([PASSWORD_DECL]);
  });

  it("refuses repository credential declarations that fail preflight", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("not found", "reference")),
    );
    await expect(
      seedSecurityReview({
        owner: "acme",
        repo: "app",
        presetId: "code-review",
        orgId: "org1",
        onePassword,
        repoFiles: repoFiles(REPO_CREDENTIALS_YAML),
      }),
    ).rejects.toMatchObject({ reason: "reference", ref: "op://Sec/Admin/password" });
  });

  it("treats an explicit empty request list as authoritative over repository declarations", async () => {
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      credentials: [],
      repoFiles: repoFiles(REPO_CREDENTIALS_YAML),
    });
    expect(result.credentialsJson).toBeNull();
  });

  it("reports every failing declaration as a warning under credentialPreflight report", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockImplementation(async (_scope: OnePasswordScope, _ctx: OnePasswordCtx, reference: string) => {
        if (reference === "op://Sec/Good/password") return "correct-horse";
        throw new OnePasswordAuthError("not found", "reference");
      }),
    );
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      credentials: [
        PASSWORD_DECL,
        { label: "good", kind: "password", env: "GOOD", reference: "op://Sec/Good/password" },
        { label: "other", kind: "password", env: "OTHER", reference: "op://Sec/Other/password" },
      ],
      onePassword,
      credentialPreflight: "report",
      repoFiles: repoFiles(null),
    });
    // Both bad ones are named, not the first alone, and the declarations stay.
    expect(result.credentialWarnings.map((w) => w.label)).toEqual(["admin", "other"]);
    expect(result.credentialWarnings[0]?.message).toMatch(/Update the reference/);
    expect(result.credentialsJson).toHaveLength(3);
  });

  it("reports a missing 1Password service as a warning under credentialPreflight report", async () => {
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      credentialPreflight: "report",
      repoFiles: repoFiles(REPO_CREDENTIALS_YAML),
    });
    expect(result.credentialWarnings.map((w) => w.label)).toEqual(["admin"]);
    expect(result.credentialWarnings[0]?.message).toMatch(/no 1Password service is configured/);
    expect(result.credentialsJson).toEqual([PASSWORD_DECL]);
  });

  it("refuses the seed when credentials are declared with no 1Password service", async () => {
    await expect(
      seedSecurityReview({
        owner: "acme",
        repo: "app",
        presetId: "code-review",
        orgId: "org1",
        credentials: [PASSWORD_DECL],
        repoFiles: repoFiles(null),
      }),
    ).rejects.toThrow(/no 1Password service is configured/);
  });

  it("refuses repository declarations with no 1Password service, like request ones", async () => {
    await expect(
      seedSecurityReview({
        owner: "acme",
        repo: "app",
        presetId: "code-review",
        orgId: "org1",
        repoFiles: repoFiles(REPO_CREDENTIALS_YAML),
      }),
    ).rejects.toThrow(/no 1Password service is configured/);
  });

  it("propagates the preflight's corrective error when a ref does not resolve", async () => {
    const onePassword = onePasswordStub(
      vi.fn().mockRejectedValue(new OnePasswordAuthError("not found", "reference")),
    );
    await expect(
      seedSecurityReview({
        owner: "acme",
        repo: "app",
        presetId: "code-review",
        orgId: "org1",
        credentials: [PASSWORD_DECL],
        onePassword,
        repoFiles: repoFiles(null),
      }),
    ).rejects.toMatchObject({ reason: "reference", ref: "op://Sec/Admin/password" });
  });

  it("populates credentialsJson and never leaks the resolved value", async () => {
    const onePassword = onePasswordStub(vi.fn().mockResolvedValue("value123"));
    const result = await seedSecurityReview({
      owner: "acme",
      repo: "app",
      presetId: "code-review",
      orgId: "org1",
      userId: "user1",
      credentials: [PASSWORD_DECL],
      onePassword,
      repoFiles: repoFiles(null),
    });
    expect(result.credentialsJson).toEqual([PASSWORD_DECL]);
    expect(JSON.stringify(result)).not.toContain("value123");
  });
});

