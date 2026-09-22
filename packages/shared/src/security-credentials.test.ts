import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENV_RE,
  CREDENTIAL_LABEL_MAX,
  CREDENTIAL_LABEL_RE,
  isOnePasswordReference,
  OP_REFERENCE_RE,
  parseDeclaredCredentials,
  RESERVED_CREDENTIAL_LABELS,
  SECURITY_CREDENTIAL_KINDS,
  validateCredentialDecl,
  validateCredentialDecls,
} from "./security-credentials.js";

const VALID = {
  label: "admin-login",
  env: "ADMIN_PASSWORD",
  reference: "op://Security/Staging admin/password",
  kind: "password",
};

/** The message of a refused validation, or "" when it was accepted. Lets a
 * test read the message without repeating the union narrowing. */
function messageOf(raw: unknown): string {
  const result = validateCredentialDecl(raw);
  return result.ok ? "" : result.message;
}

describe("the vocabulary itself", () => {
  it("names the seven kinds", () => {
    expect([...SECURITY_CREDENTIAL_KINDS]).toEqual([
      "password",
      "session",
      "headerToken",
      "mtls",
      "signingKey",
      "toolAuth",
      "testData",
    ]);
  });

  it("reserves the eight names sandbox prep installs", () => {
    expect([...RESERVED_CREDENTIAL_LABELS].sort()).toEqual([
      "gh",
      "git-credential-valet",
      "gitleaks",
      "op",
      "sec-preflight",
      "semgrep",
      "valet-gh",
      "valet-secrets",
    ]);
  });

  it("accepts a label that starts with a letter or digit and refuses one that does not", () => {
    expect(CREDENTIAL_LABEL_RE.test("admin-login")).toBe(true);
    expect(CREDENTIAL_LABEL_RE.test("9lives.v2_a")).toBe(true);
    expect(CREDENTIAL_LABEL_RE.test("-admin")).toBe(false);
    expect(CREDENTIAL_LABEL_RE.test("admin login")).toBe(false);
    expect(CREDENTIAL_LABEL_MAX).toBe(128);
  });

  it("accepts the env names an export statement accepts", () => {
    expect(CREDENTIAL_ENV_RE.test("ADMIN_PASSWORD")).toBe(true);
    expect(CREDENTIAL_ENV_RE.test("_private")).toBe(true);
    expect(CREDENTIAL_ENV_RE.test("1TOKEN")).toBe(false);
    expect(CREDENTIAL_ENV_RE.test("ADMIN-TOKEN")).toBe(false);
  });

  it("accepts the three-segment and four-segment op:// forms only", () => {
    expect(OP_REFERENCE_RE.test("op://Security/Staging admin/password")).toBe(true);
    expect(OP_REFERENCE_RE.test("op://Security/Item/Section/field")).toBe(true);
    expect(OP_REFERENCE_RE.test("op://Security/Item")).toBe(false);
    expect(OP_REFERENCE_RE.test("op://a/b/c/d/e")).toBe(false);
    expect(isOnePasswordReference("op://Security/Staging admin/password")).toBe(true);
    expect(isOnePasswordReference("not-an-op-reference")).toBe(false);
  });
});

describe("validateCredentialDecl", () => {
  it("accepts a valid declaration and returns it normalized", () => {
    const result = validateCredentialDecl({ ...VALID, refShape: "raw", meta: { scheme: "Bearer" } });
    expect(result).toEqual({
      ok: true,
      decl: {
        label: "admin-login",
        env: "ADMIN_PASSWORD",
        reference: "op://Security/Staging admin/password",
        kind: "password",
        refShape: "raw",
        meta: { scheme: "Bearer" },
      },
    });
  });

  it("omits refShape and meta when the declaration omits them", () => {
    const result = validateCredentialDecl(VALID);
    expect(result).toEqual({ ok: true, decl: { ...VALID } });
  });

  it("refuses a label that starts with a hyphen and shows a working example", () => {
    expect(messageOf({ ...VALID, label: "-admin" })).toBe(
      'Label "-admin" is not valid. Use letters, digits, underscore, period, or hyphen, ' +
        'starting with a letter or digit, for example "admin-login".',
    );
  });

  it("refuses a label longer than 128 characters", () => {
    const message = messageOf({ ...VALID, label: "a".repeat(129) });
    expect(message).toContain("is too long");
    expect(message).toContain("at most 128 characters");
    expect(message).toContain('"admin-login"');
  });

  it("accepts a label of exactly 128 characters", () => {
    expect(validateCredentialDecl({ ...VALID, label: "a".repeat(128) }).ok).toBe(true);
  });

  it("refuses a reserved label and names the reserved list", () => {
    const message = messageOf({ ...VALID, label: "gh" });
    expect(message).toContain('"gh" is reserved by sandbox prep');
    expect(message).toContain("git-credential-valet");
    expect(message).toContain("valet-secrets");
    expect(message).toContain('"admin-login"');
  });

  it("accepts a lowercase env name, because the server rule allows it", () => {
    const result = validateCredentialDecl({ ...VALID, env: "adminToken" });
    expect(result.ok).toBe(true);
  });

  it("refuses an env name that starts with a digit", () => {
    const message = messageOf({ ...VALID, env: "1TOKEN" });
    expect(message).toContain('env name "1TOKEN"');
    expect(message).toContain("do not start with a digit");
    expect(message).toContain('"ADMIN_PASSWORD"');
  });

  it("refuses a reference that is not an op:// path and shows the op:// form", () => {
    const message = messageOf({ ...VALID, reference: "not-an-op-reference" });
    expect(message).toContain("is not a valid op:// path");
    expect(message).toContain("op://vault/item/field");
    expect(message).toContain('"op://Security/Staging admin/password"');
  });

  it("refuses an unknown kind and lists the known kinds", () => {
    const message = messageOf({ ...VALID, kind: "bogus" });
    expect(message).toContain("unknown kind");
    expect(message).toContain("password, session, headerToken, mtls, signingKey, toolAuth, testData");
  });

  it("refuses an invalid refShape", () => {
    const message = messageOf({ ...VALID, refShape: "yaml" });
    expect(message).toContain("refShape");
    expect(message).toContain('"raw"');
    expect(message).toContain('"json"');
  });

  it("refuses a value that is not an object", () => {
    expect(messageOf("admin-login")).toContain("must be an object with label, env, reference, and kind");
    expect(messageOf(null)).toContain("must be an object with label, env, reference, and kind");
    expect(messageOf([VALID])).toContain("must be an object with label, env, reference, and kind");
  });

  it("refuses a meta that is not an object", () => {
    const message = messageOf({ ...VALID, meta: "certRef=op://a/b/c" });
    expect(message).toContain("meta");
    expect(message).toContain('{ "scheme": "Bearer" }');
  });

  it("refuses a non-string meta.certRef instead of dropping it during normalization", () => {
    const message = messageOf({ ...VALID, kind: "mtls", meta: { certRef: 123 } });
    // The refusal names the field the way the form labels it, not the wire
    // key, so a reader fixes it without knowing the schema.
    expect(message).toContain("has an invalid certificate reference");
    expect(message).toContain('"op://Security/Partner/cert"');
  });

  it("refuses a meta.certRef that is a string but not an op:// reference", () => {
    const message = messageOf({ ...VALID, kind: "mtls", meta: { certRef: "not-a-reference" } });
    expect(message).toContain("has an invalid certificate reference");
    expect(message).toContain("use an op:// path");
  });

  it("refuses a meta.certRef on a credential that is not mtls", () => {
    const message = messageOf({ ...VALID, meta: { certRef: "op://Security/Partner/cert" } });
    expect(message).toContain("only on an mTLS client cert credential");
  });

  it("accepts an mtls credential carrying a valid certRef", () => {
    const result = validateCredentialDecl({
      ...VALID,
      kind: "mtls",
      meta: { certRef: "op://Security/Partner/cert" },
    });
    expect(result).toEqual({
      ok: true,
      decl: { ...VALID, kind: "mtls", meta: { certRef: "op://Security/Partner/cert" } },
    });
  });

  it("accepts an mtls credential with no certRef, which the preflight allows", () => {
    expect(validateCredentialDecl({ ...VALID, kind: "mtls" }).ok).toBe(true);
  });

  it("keeps only the string values of meta, so one odd value never erases a declaration", () => {
    const result = validateCredentialDecl({ ...VALID, meta: { scheme: "Bearer", retries: 3 } });
    expect(result).toEqual({ ok: true, decl: { ...VALID, meta: { scheme: "Bearer" } } });
  });
});

describe("validateCredentialDecls", () => {
  it("accepts a list of valid declarations", () => {
    const result = validateCredentialDecls([
      VALID,
      { label: "admin-api", env: "ADMIN_API_TOKEN", reference: "op://Security/Admin API/token", kind: "headerToken" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.decls.map((d) => d.label)).toEqual(["admin-login", "admin-api"]);
  });

  it("accepts an empty list", () => {
    expect(validateCredentialDecls([])).toEqual({ ok: true, decls: [] });
  });

  it("refuses a value that is not a list", () => {
    const result = validateCredentialDecls({ label: "admin-login" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("list");
  });

  it("refuses a duplicate label", () => {
    const result = validateCredentialDecls([
      VALID,
      { ...VALID, env: "ADMIN_PASSWORD_B", reference: "op://Security/Other/password" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      'Credential label "admin-login" is declared more than once',
    );
  });

  it("refuses a duplicate env name", () => {
    const result = validateCredentialDecls([
      VALID,
      { ...VALID, label: "admin-api", reference: "op://Security/Admin API/token" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('env name "ADMIN_PASSWORD"');
    expect(result.ok === false && result.message).toContain("unique env name");
  });

  it("reports the first bad declaration with the shared per-declaration message", () => {
    const result = validateCredentialDecls([VALID, { ...VALID, label: "-admin" }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Label "-admin" is not valid');
  });
});

describe("parseDeclaredCredentials", () => {
  it("returns [] for null, undefined, a non-list, and an empty list", () => {
    expect(parseDeclaredCredentials(null)).toEqual([]);
    expect(parseDeclaredCredentials(undefined)).toEqual([]);
    expect(parseDeclaredCredentials("credentials")).toEqual([]);
    expect(parseDeclaredCredentials([])).toEqual([]);
  });

  it("drops a malformed entry and keeps the rest", () => {
    const good = { label: "admin-api", env: "ADMIN_API_TOKEN", reference: "op://Security/Admin API/token", kind: "headerToken" };
    expect(parseDeclaredCredentials([VALID, { label: "-admin" }, null, good])).toEqual([
      { ...VALID },
      { ...good },
    ]);
  });

  it("drops an entry whose kind is not a known kind", () => {
    expect(parseDeclaredCredentials([{ ...VALID, kind: "bogus" }])).toEqual([]);
  });

  it("never throws on a malformed value", () => {
    expect(() => parseDeclaredCredentials([1, "x", [], { meta: 3 }])).not.toThrow();
    expect(parseDeclaredCredentials([1, "x", [], { meta: 3 }])).toEqual([]);
  });

  it("drops an mtls entry whose certRef is not a usable reference", () => {
    expect(parseDeclaredCredentials([{ ...VALID, kind: "mtls", meta: { certRef: 123 } }])).toEqual([]);
  });

  it("keeps a duplicate label, because the strict validator owns that rule", () => {
    expect(parseDeclaredCredentials([VALID, VALID])).toHaveLength(2);
  });
});
