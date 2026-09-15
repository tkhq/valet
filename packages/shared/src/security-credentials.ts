/**
 * The one credential vocabulary a security engagement speaks.
 *
 * A declared credential says: a persona may use the secret at this `op://`
 * reference, under this `label`, delivered as this environment variable. The
 * label becomes a launcher command name in the sandbox, and the env name
 * becomes an `export` in the script that launcher writes, so both are held to
 * a name shape that survives a filesystem path and a shell.
 *
 * The API create route, the repo config parser, the sandbox broker, and the
 * setup form all validate the same declaration. They used to hold four copies
 * of these rules, and the copies drifted: one accepted a leading hyphen the
 * others refused, another refused a lowercase env name the others accepted.
 * This module holds the rules once, so a declaration the form accepts is a
 * declaration the server accepts.
 *
 * Two entry points, with different jobs:
 *
 *   - `validateCredentialDecl` / `validateCredentialDecls` are strict. They
 *     answer "may this declaration enter the system?" and refuse with a
 *     message that names the fix.
 *   - `parseDeclaredCredentials` is tolerant. It answers "what did we store?"
 *     for a JSONB column, drops what it cannot read, and never throws.
 */

/** The seven kinds a declared credential can be. `kind` drives the preflight
 * shape check and the usage hint a persona reads. */
export const SECURITY_CREDENTIAL_KINDS = [
  "password",
  "session",
  "headerToken",
  "mtls",
  "signingKey",
  "toolAuth",
  "testData",
] as const;

export type SecurityCredentialKind = (typeof SECURITY_CREDENTIAL_KINDS)[number];

/** One declared credential. */
export interface SecurityCredentialDecl {
  /** Unique per engagement. Names the credential to the persona, the needs
   * panel, and the launcher command. It is a command filename, not an env
   * name. */
  label: string;
  /** The environment variable name the launcher injects. */
  env: string;
  /** The `op://` path the sandbox resolves at run time. */
  reference: string;
  /** Drives the preflight shape check and the persona's usage hint. */
  kind: SecurityCredentialKind;
  /** `raw` (default) passes the resolved field text as is. `json` asserts the
   * value parses as JSON. */
  refShape?: "raw" | "json";
  /** Per-kind sidecar values such as a header scheme or a certificate
   * reference. Never a resolved credential value. */
  meta?: Record<string, string>;
}

/** A label becomes a path under `/usr/local/bin`, so it has to be a bare
 * filename: anything with a slash or a space would either escape that
 * directory or never be found. */
export const CREDENTIAL_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The longest label the create route accepts. A launcher name this long is
 * already unreadable, and the cap keeps one declaration from filling a
 * prompt. */
export const CREDENTIAL_LABEL_MAX = 128;

/** The same shape `export` accepts, checked before a name reaches a shell
 * that would quote the VALUE next to it in its error. */
export const CREDENTIAL_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The one `op://` grammar. `op://vault/item/field` or
 * `op://vault/item/section/field`, the two forms the 1Password SDK resolves.
 * A segment may contain spaces ("ProDex Labs" is an ordinary vault name) but
 * not a slash or a control character. The prefix and the segment count keep
 * this from becoming a general read primitive: a path, an env var name, or a
 * URL does not match.
 */
export const OP_REFERENCE_RE =
  /^op:\/\/[^/\u0000-\u001f]+\/[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+){1,2}$/;

export function isOnePasswordReference(value: string): boolean {
  return OP_REFERENCE_RE.test(value);
}

/** Names sandbox prep and the security bootstrap install. A credential
 * launcher must never replace one of these privileged helpers. */
export const RESERVED_CREDENTIAL_LABELS: ReadonlySet<string> = new Set([
  "git-credential-valet",
  "valet-gh",
  "gh",
  "valet-secrets",
  "op",
  "sec-preflight",
  "gitleaks",
  "semgrep",
]);

export type CredentialDeclValidation =
  | { ok: true; decl: SecurityCredentialDecl }
  | { ok: false; message: string };

/** An example declaration, quoted in the messages so a reader sees a working
 * shape next to the rule that refused theirs. */
const EXAMPLE_LABEL = "admin-login";
const EXAMPLE_ENV = "ADMIN_PASSWORD";
const EXAMPLE_REFERENCE = "op://Security/Staging admin/password";
const EXAMPLE_DECL =
  `{ "label": "${EXAMPLE_LABEL}", "env": "${EXAMPLE_ENV}", ` +
  `"reference": "${EXAMPLE_REFERENCE}", "kind": "password" }`;

/** Quote a rejected value for a message. Anything not a string shows as JSON,
 * and a long value is cut, so one pasted blob cannot fill the message. */
function show(value: unknown): string {
  const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? String(value);
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownKind(value: unknown): value is SecurityCredentialKind {
  // `includes` on a readonly tuple of literals refuses an arbitrary string
  // argument, so the tuple widens to string[] for the membership test only.
  return typeof value === "string" && (SECURITY_CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/** Keep the string values of a meta map and drop the rest. A sidecar value
 * that is not text has no reader, and dropping it leaves the declaration
 * usable instead of erasing it. */
function stringValuesOf(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Validate one declaration. On success the returned `decl` is normalized: it
 * carries the six known fields and nothing else, so a caller can persist it
 * without carrying an unknown key into the database.
 */
export function validateCredentialDecl(raw: unknown): CredentialDeclValidation {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: `A credential must be an object with label, env, reference, and kind, for example ${EXAMPLE_DECL}.`,
    };
  }

  if (typeof raw.label !== "string" || !CREDENTIAL_LABEL_RE.test(raw.label)) {
    return {
      ok: false,
      message:
        `Label ${show(raw.label)} is not valid. Use letters, digits, underscore, period, or hyphen, ` +
        `starting with a letter or digit, for example "${EXAMPLE_LABEL}".`,
    };
  }
  const label = raw.label;
  if (label.length > CREDENTIAL_LABEL_MAX) {
    return {
      ok: false,
      message:
        `Label ${show(label)} is too long. Use at most ${CREDENTIAL_LABEL_MAX} characters, ` +
        `for example "${EXAMPLE_LABEL}".`,
    };
  }
  if (RESERVED_CREDENTIAL_LABELS.has(label)) {
    return {
      ok: false,
      message:
        `Label "${label}" is reserved by sandbox prep. Choose a label that is not one of ` +
        `${[...RESERVED_CREDENTIAL_LABELS].join(", ")}, for example "${EXAMPLE_LABEL}".`,
    };
  }

  if (typeof raw.env !== "string" || !CREDENTIAL_ENV_RE.test(raw.env)) {
    return {
      ok: false,
      message:
        `Credential "${label}" has an invalid env name ${show(raw.env)}. Use letters, digits, and ` +
        `underscore, and do not start with a digit, for example "${EXAMPLE_ENV}".`,
    };
  }

  if (typeof raw.reference !== "string" || !OP_REFERENCE_RE.test(raw.reference)) {
    return {
      ok: false,
      message:
        `Credential "${label}" has a reference ${show(raw.reference)} that is not a valid op:// path. ` +
        `Use op://vault/item/field or op://vault/item/section/field, for example "${EXAMPLE_REFERENCE}".`,
    };
  }

  if (!isKnownKind(raw.kind)) {
    return {
      ok: false,
      message:
        `Credential "${label}" has an unknown kind ${show(raw.kind)}. Use one of ` +
        `${SECURITY_CREDENTIAL_KINDS.join(", ")}, for example "password".`,
    };
  }

  if (raw.refShape !== undefined && raw.refShape !== "raw" && raw.refShape !== "json") {
    return {
      ok: false,
      message:
        `Credential "${label}" has an invalid refShape ${show(raw.refShape)}. Use "raw" or "json", ` +
        `for example "raw".`,
    };
  }

  if (raw.meta !== undefined && !isPlainObject(raw.meta)) {
    return {
      ok: false,
      message:
        `Credential "${label}" has an invalid meta ${show(raw.meta)}. Use an object of text values, ` +
        `for example { "scheme": "Bearer" }.`,
    };
  }

  // `certRef` is the one meta key with a meaning: the second reference the
  // broker must resolve for an mTLS launcher. It is optional, but a certRef
  // that is present and unusable has to refuse here. Normalization below keeps
  // only text values, so an unchecked non-string certRef would vanish quietly
  // and the launcher would run with no certificate.
  if (raw.meta !== undefined) {
    const certRef = raw.meta.certRef;
    if (
      certRef !== undefined &&
      (raw.kind !== "mtls" || typeof certRef !== "string" || !OP_REFERENCE_RE.test(certRef))
    ) {
      return {
        ok: false,
        message:
          `Credential "${label}" has an invalid certificate reference: use an op:// path, ` +
          `and only on an mTLS client cert credential, for example "op://Security/Partner/cert".`,
      };
    }
  }

  return {
    ok: true,
    decl: {
      label,
      env: raw.env,
      reference: raw.reference,
      kind: raw.kind,
      ...(raw.refShape !== undefined ? { refShape: raw.refShape } : {}),
      ...(raw.meta !== undefined ? { meta: stringValuesOf(raw.meta) } : {}),
    },
  };
}

/**
 * The refusal shown when two declarations share an env name. Each declaration
 * becomes an `export` in the same launcher script, so a repeat would have one
 * credential overwrite the other. Exported because a form that checks rows as
 * they are typed has no whole-list call to refuse from, and it must show the
 * same sentence the create route returns. `label` may be empty while a row is
 * still being filled in.
 */
export function duplicateEnvMessage(label: string, env: string): string {
  const who = label === "" ? "A credential" : `Credential "${label}"`;
  return (
    `${who} reuses the env name "${env}". Give each credential a unique env name, ` +
    `for example "ADMIN_API_TOKEN".`
  );
}

/**
 * Validate a whole list. Adds the two rules a single declaration cannot see:
 * a label is a launcher command name and an env name is an `export` target,
 * so a repeat of either would have one declaration overwrite another.
 */
export function validateCredentialDecls(
  raw: unknown,
): { ok: true; decls: SecurityCredentialDecl[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message: `Declare credentials as a list, for example [${EXAMPLE_DECL}].`,
    };
  }

  const decls: SecurityCredentialDecl[] = [];
  const labels = new Set<string>();
  const envs = new Set<string>();
  for (const entry of raw) {
    const result = validateCredentialDecl(entry);
    if (!result.ok) return result;
    const decl = result.decl;
    if (labels.has(decl.label)) {
      return {
        ok: false,
        message:
          `Credential label "${decl.label}" is declared more than once. Give each credential a ` +
          `unique label, for example "${EXAMPLE_LABEL}" and "admin-api".`,
      };
    }
    if (envs.has(decl.env)) {
      return { ok: false, message: duplicateEnvMessage(decl.label, decl.env) };
    }
    labels.add(decl.label);
    envs.add(decl.env);
    decls.push(decl);
  }
  return { ok: true, decls };
}

/**
 * Read a stored `credentials_json` value. Every declaration in that column
 * entered through a strict validator, so an entry this drops is an entry the
 * readers below could not have used anyway: a launcher it cannot name, a
 * reference it cannot resolve. Returns the readable declarations and never
 * throws, so one bad row cannot take down a dispatch, a wrapper install, or
 * a broker allowlist.
 *
 * Duplicates survive here. The strict validator owns that rule, and a reader
 * that cares (the launcher install) drops a repeat itself.
 */
export function parseDeclaredCredentials(json: unknown): SecurityCredentialDecl[] {
  if (!Array.isArray(json)) return [];
  const decls: SecurityCredentialDecl[] = [];
  for (const entry of json) {
    const result = validateCredentialDecl(entry);
    if (result.ok) decls.push(result.decl);
  }
  return decls;
}
