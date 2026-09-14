/**
 * Seed a security review's config + plan from a repo's `.valet/security.yml`,
 * with the sweep preset as the fallback (dynamic-config M-F1, spec §Dynamic
 * configuration). ONE owner of the create-time seeding logic.
 *
 * The setup page's preview endpoint (`POST /api/sessions/security/preview`) and
 * the session-create route both call `seedSecurityReview`, so a preview shows
 * exactly what create would seed. The function reads the config through the
 * GitHub contents API BEFORE any sandbox exists; a public repo needs no token.
 *
 * Behavior, identical to the create route's old inline block:
 *   - A valid config with steps seeds the plan from the steps.
 *   - A valid config with no steps keeps the preset plan but carries the
 *     config's focus / invariants / categories / personas / tools / scope.
 *   - An absent, malformed, or unreadable config falls back to the preset plan;
 *     `hasRepoConfig` is false and the config fields are null/empty.
 *   - Repo-declared persona role markdown resolves from the clone at seed time;
 *     a missing/unreadable file is skipped with a note.
 *
 * Credential preflight (Part 12, INV-33): when the caller passes `credentials`
 * (a security engagement's declared `op://` references), `seedSecurityReview`
 * resolves every one of them through `OnePasswordService.resolveReference`,
 * shape-checks the resolved value by `kind`, and drops the value immediately.
 * A resolve failure or a shape-check failure refuses the whole seed with a
 * `SecurityCredentialPreflightError` naming the label and a corrective remedy.
 * No sandbox exists yet at this point, so a bad reference never reaches a
 * running engagement. A credential the REPOSITORY declares takes the same
 * preflight as one the request declares, and both refuse the seed when no
 * 1Password service can resolve them: a declaration that was never validated
 * is a credential the engagement cannot use.
 *
 * `SecurityConfigCredentialDecl` (below) is the wire type
 * `SecurityConfigCredentialDeclWire` (`../wire/types.js`) under a local
 * name: the setup page's wizard imports the same wire type for its
 * `CredentialDraft`, and `.valet/security.yml`'s `credentials:` list is
 * field-compatible (`label`, `kind`, `env`, `reference`, `refShape?`,
 * `meta?`).
 */
import {
  bundledPersonaIds,
  configToPlanYaml,
  parseSecurityConfig,
  presetPlan,
  type SecurityConfig,
  type SecurityScope,
  type ToolDecl,
} from "@valet/plugin-security";
import { fetchRepoFile, resolveApiTokenOrNull } from "../bakes/source-service.js";
import type { GitHubTokenDeps } from "../services/github-tokens.js";
import type {
  SecurityConfigCredentialDeclWire,
  SecurityCredentialWarningWire,
} from "../wire/types.js";
import {
  isOnePasswordReference,
  OnePasswordAuthError,
  type OnePasswordCtx,
  type OnePasswordErrorKind,
  type OnePasswordService,
} from "./onepassword.js";
import {
  onePasswordScopesFor,
  resolveAcrossScopes,
  type ScopeResolveAttempt,
} from "./credential-resolution.js";

interface SeedSecurityReviewBase {
  /** The repo owner (the `owner` half of `owner/repo`). */
  owner: string;
  /** The repo name (the `repo` half of `owner/repo`). */
  repo: string;
  /** Optional branch / tag / SHA to read the config at. Omit for the default
   * branch HEAD. */
  ref?: string;
  /** The sweep preset id, the plan fallback when the repo has no config steps. */
  presetId: string;
  /** Optional include globs the preset sweeps scope to. */
  paths?: string[];
  /** "Include a written report at the end" (Part 08 §Setup Step 1). When
   * present, the seeded preset plan appends or skips the report cell. When
   * absent, `presetPlan` falls to the preset's own default per
   * `presetReportDefault`. */
  includeReport?: boolean;
  /** The owning org, for `resolveApiTokenOrNull`. */
  orgId: string;
  /** The declared 1Password credential references to preflight-validate
   * before the seed succeeds (Part 12, INV-33). Absent or empty skips
   * preflight entirely and leaves `credentialsJson` null. */
  credentials?: SecurityConfigCredentialDecl[];
  /** The 1Password service the preflight resolves references through.
   * Required whenever a credential is declared, by this request or by the
   * repository; `seedSecurityReview` refuses the seed with a plain
   * configuration error otherwise. */
  onePassword?: Pick<OnePasswordService, "resolveReference">;
  /** The acting user id, for the preflight's `OnePasswordCtx`. Only the
   * `personal` scope reads it; other scopes ignore it. */
  userId?: string;
  /** The session owner type (`user` | `team` | anything else), for
   * `onePasswordScopesFor`. Absent resolves to the org-only scope. */
  ownerType?: string;
  /** The owning team id, required alongside `ownerType: "team"` to unlock
   * the team scope. */
  teamId?: string;
  /** What a declared credential that fails preflight does to the seed.
   * `refuse` (the default) throws, which is how create refuses to start a
   * review with a credential nobody can resolve. `report` keeps the
   * declarations and returns the failures in `credentialWarnings`, for the
   * read-only preview: it shows the problem without blocking the page. */
  credentialPreflight?: CredentialPreflightMode;
}

/** How the seed treats a preflight failure: throw, or report it. */
export type CredentialPreflightMode = "refuse" | "report";

/**
 * The seed's two reads against a repository: the API token for it, and one
 * file's text. `githubRepoFiles` is the real implementation; a test passes
 * its own reader and needs no `tokenDeps`.
 */
export interface RepoFileReader {
  resolveApiTokenOrNull(orgId: string, owner: string, repo: string): Promise<string | null>;
  fetchRepoFile(
    token: string | null,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string | null>;
}

/**
 * How the seed reads a repository, and what it needs to read one.
 *
 * `tokenDeps` is what `githubRepoFiles` authenticates with, so it is
 * required only when the caller lets the seed build that reader. A caller
 * that injects `repoFiles` supplies the reads itself and states no token
 * deps.
 */
export type SeedSecurityReviewArgs = SeedSecurityReviewBase &
  (
    | { tokenDeps: GitHubTokenDeps; repoFiles?: RepoFileReader }
    | { tokenDeps?: GitHubTokenDeps; repoFiles: RepoFileReader }
  );

/** The real reader: the `source-service` GitHub-contents functions, bound to
 * one caller's token deps. */
function githubRepoFiles(tokenDeps: GitHubTokenDeps | undefined): RepoFileReader {
  if (!tokenDeps) {
    throw new Error(
      "seedSecurityReview cannot read the repository: it has no GitHub token deps. " +
        "Pass tokenDeps, or pass repoFiles to read the repository another way.",
    );
  }
  return {
    resolveApiTokenOrNull: (orgId, owner, repo) => resolveApiTokenOrNull(tokenDeps, orgId, owner, repo),
    fetchRepoFile: (token, owner, repo, path, ref) =>
      fetchRepoFile(tokenDeps, token, owner, repo, path, ref),
  };
}

/** The seeded config + plan a preview shows and a create stores. */
export interface SeededSecurityReview {
  /** The plan YAML: the config's steps, or the preset fallback. */
  planYaml: string;
  focus: string | null;
  invariants: string[];
  categories: string[];
  /** Repo-defined personas: id → the markdown path in the clone. Null when
   * absent. */
  personas: Record<string, string> | null;
  /** Repo-defined persona role markdown, resolved from the clone. Null when
   * absent. */
  configPersonaMarkdown: Record<string, string> | null;
  /** Declared tools (M-P4a). Null when absent. */
  tools: ToolDecl[] | null;
  /** The authorized live-testing scope (M-P4b). Null when absent. */
  scope: SecurityScope | null;
  /** True when a valid `.valet/security.yml` seeded this review. */
  hasRepoConfig: boolean;
  /** The preflight-validated declared credentials (Part 12, INV-33). Null
   * when the request declared none. Carries only `op://` references and
   * metadata, never a resolved value (INV-37). */
  credentialsJson: SecurityConfigCredentialDecl[] | null;
  /** Declared credentials that failed preflight under
   * `credentialPreflight: "report"`. Always empty under `refuse`, which
   * throws on the first failure instead. */
  credentialWarnings: SecurityCredentialWarning[];
}

/** One declared credential that failed preflight, and what to do about it. */
export type SecurityCredentialWarning = SecurityCredentialWarningWire;

/**
 * Seed the config + plan a security review starts from. Never throws for a
 * missing / malformed / unreadable config — it falls back to the preset plan
 * and records `hasRepoConfig: false`. A malformed preset id DOES throw
 * (`presetPlan`), because the caller validated it first.
 */
export async function seedSecurityReview(args: SeedSecurityReviewArgs): Promise<SeededSecurityReview> {
  const { owner, repo, ref, presetId, paths, includeReport, orgId } = args;
  const { resolveApiTokenOrNull: resolveToken, fetchRepoFile: readRepoFile } =
    args.repoFiles ?? githubRepoFiles(args.tokenDeps);

  const result: SeededSecurityReview = {
    planYaml: presetPlan(presetId, {
      ...(paths ? { paths } : {}),
      ...(includeReport !== undefined ? { includeReport } : {}),
    }),
    focus: null,
    invariants: [],
    categories: [],
    personas: null,
    configPersonaMarkdown: null,
    tools: null,
    scope: null,
    hasRepoConfig: false,
    credentialsJson: null,
    credentialWarnings: [],
  };

  const ownerCtx: CredentialPreflightCtx = {
    orgId,
    userId: args.userId ?? "",
    ...(args.ownerType ? { ownerType: args.ownerType } : {}),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  };

  // A request-declared credential is preflighted first: it never depends on
  // the repo's `.valet/security.yml`, and a bad reference must refuse the
  // seed before any sandbox exists, not once an engagement is already
  // running.
  const mode: CredentialPreflightMode = args.credentialPreflight ?? "refuse";
  if (args.credentials && args.credentials.length > 0) {
    const preflighted = await preflightDeclared(args.credentials, ownerCtx, args.onePassword, mode);
    result.credentialsJson = preflighted.decls;
    result.credentialWarnings = preflighted.warnings;
  }

  // What the repository declares, held for the preflight AFTER the try below.
  // The catch there turns an unreadable config into the preset fallback, and
  // a credential refusal must refuse the seed instead of falling back.
  let repoCredentials: SecurityConfigCredentialDecl[] | undefined;

  try {
    const token = await resolveToken(orgId, owner, repo);
    const raw = await readRepoFile(token, owner, repo, ".valet/security.yml", ref);
    if (raw === null) return result;

    const config: SecurityConfig = parseSecurityConfig(raw, bundledPersonaIds());
    result.hasRepoConfig = true;
    result.focus = config.focus ?? null;
    result.invariants = config.invariants ?? [];
    result.categories = config.categories ?? [];
    result.personas = config.personas ?? null;
    result.tools = config.tools ?? null;
    result.scope = config.scope ?? null;
    // The setup-page request is authoritative when it supplied credentials.
    // Otherwise the repository declaration stands, and takes the same
    // preflight below.
    if (args.credentials === undefined && config.credentials && config.credentials.length > 0) {
      repoCredentials = config.credentials;
    }

    // A config with steps seeds the plan; a config with no steps keeps the
    // preset plan but still carries the config context above.
    if (config.steps && config.steps.length > 0) {
      result.planYaml = configToPlanYaml(config);
    }

    // Repo-defined persona roles (M-P2c): resolve each persona's markdown from
    // the clone. A missing / empty / unreadable file is skipped with a note;
    // the host then falls back to the code-review role for that persona.
    if (config.personas && Object.keys(config.personas).length > 0) {
      const resolved: Record<string, string> = {};
      for (const [personaId, personaPath] of Object.entries(config.personas)) {
        try {
          const md = await readRepoFile(token, owner, repo, personaPath, ref);
          if (md !== null && md.trim() !== "") {
            resolved[personaId] = md;
          } else {
            console.warn(
              `security seed: repo persona "${personaId}" file "${personaPath}" is empty or missing; ` +
                "the host will fall back to the code-review role for it.",
            );
          }
        } catch (fetchErr) {
          const m = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          console.warn(
            `security seed: repo persona "${personaId}" file "${personaPath}" is unreadable (${m}); ` +
              "the host will fall back to the code-review role for it.",
          );
        }
      }
      if (Object.keys(resolved).length > 0) result.configPersonaMarkdown = resolved;
    }
  } catch (err) {
    // A missing, malformed, or unreadable config is not a failure — fall back to
    // the preset plan and record why. Reset any partial config state.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`security seed: .valet/security.yml ignored for ${owner}/${repo}: ${message}`);
    result.hasRepoConfig = false;
    result.focus = null;
    result.invariants = [];
    result.categories = [];
    result.personas = null;
    result.configPersonaMarkdown = null;
    result.tools = null;
    result.scope = null;
    result.planYaml = presetPlan(presetId, {
      ...(paths ? { paths } : {}),
      ...(includeReport !== undefined ? { includeReport } : {}),
    });
  }

  if (repoCredentials) {
    const preflighted = await preflightDeclared(repoCredentials, ownerCtx, args.onePassword, mode);
    result.credentialsJson = preflighted.decls;
    result.credentialWarnings = preflighted.warnings;
  }

  return result;
}

/**
 * Preflight one set of declared credentials, whoever declared them. No
 * 1Password service means nothing can validate the references, which refuses
 * the seed under `refuse`: storing an unvalidated reference hands the failure
 * to a running engagement instead.
 *
 * Under `report`, every declaration is preflighted on its own, so the caller
 * learns about all the bad ones at once instead of the first one only.
 */
async function preflightDeclared(
  decls: readonly SecurityConfigCredentialDecl[],
  ctx: CredentialPreflightCtx,
  onePassword: Pick<OnePasswordService, "resolveReference"> | undefined,
  mode: CredentialPreflightMode,
): Promise<{ decls: SecurityConfigCredentialDecl[]; warnings: SecurityCredentialWarning[] }> {
  if (!onePassword) {
    const message =
      "Security config declares credentials, but no 1Password service is configured to resolve them. " +
      "Connect a 1Password service account token in Organization > 1Password.";
    if (mode === "refuse") throw new Error(message);
    return {
      decls: decls.map((decl) => ({ ...decl })),
      warnings: decls.map((decl) => ({ label: decl.label, message })),
    };
  }
  if (mode === "refuse") {
    return { decls: await preflightCredentials(decls, ctx, onePassword), warnings: [] };
  }
  const warnings: SecurityCredentialWarning[] = [];
  for (const decl of decls) {
    try {
      await preflightCredentials([decl], ctx, onePassword);
    } catch (err) {
      if (!(err instanceof SecurityCredentialPreflightError)) throw err;
      warnings.push({ label: decl.label, message: err.remedy });
    }
  }
  return { decls: decls.map((decl) => ({ ...decl })), warnings };
}

/** Build the `SecurityConfigContext` the engagement service stores from a seeded
 * review plus optional user overrides from the setup page. The user edits
 * focus / invariants / categories; the repo-committed tools / scope / personas
 * stay from the seed. Returns undefined only when nothing configures the
 * engagement (a preset-only review with no overrides), so the engagement records
 * `has_repo_config = false`. */
export function seededConfigContext(
  seeded: SeededSecurityReview,
  overrides?: {
    focus?: string | null;
    invariants?: string[];
    categories?: string[];
    /** Setup-page scope override (Part 08 §Setup Step 1). A non-null value
     * with non-empty hosts wins over the repo-seeded scope; null clears the
     * override and falls back to seed. Empty hosts array is not accepted at
     * this seam (rejected by the create-route validator). */
    scope?: SecurityScope | null;
  },
): {
  focus?: string;
  invariants?: string[];
  categories?: string[];
  personas?: Record<string, string>;
  personaMarkdown?: Record<string, string>;
  tools?: ToolDecl[];
  scope?: SecurityScope;
} | undefined {
  const focusRaw = overrides && "focus" in overrides ? overrides.focus : seeded.focus;
  const focus = focusRaw?.trim() ? focusRaw.trim() : undefined;
  const invariants = (overrides?.invariants ?? seeded.invariants)
    .map((v) => v.trim())
    .filter((v) => v !== "");
  const categories = (overrides?.categories ?? seeded.categories)
    .map((v) => v.trim())
    .filter((v) => v !== "");

  const ctx: {
    focus?: string;
    invariants?: string[];
    categories?: string[];
    personas?: Record<string, string>;
    personaMarkdown?: Record<string, string>;
    tools?: ToolDecl[];
    scope?: SecurityScope;
  } = {};
  if (focus !== undefined) ctx.focus = focus;
  if (invariants.length > 0) ctx.invariants = invariants;
  if (categories.length > 0) ctx.categories = categories;
  if (seeded.personas) ctx.personas = seeded.personas;
  if (seeded.configPersonaMarkdown) ctx.personaMarkdown = seeded.configPersonaMarkdown;
  if (seeded.tools) ctx.tools = seeded.tools;
  // Setup-page scope override (Part 08 §Setup Step 1) wins over the repo seed
  // when present with non-empty hosts. `null` explicitly clears the override
  // and falls back to the seed. Undefined leaves the seed untouched.
  if (overrides && "scope" in overrides) {
    const s = overrides.scope;
    if (s !== null && s !== undefined && Array.isArray(s.hosts) && s.hosts.length > 0) {
      ctx.scope = s;
    } else if (seeded.scope) {
      ctx.scope = seeded.scope;
    }
  } else if (seeded.scope) {
    ctx.scope = seeded.scope;
  }

  // The engagement records `has_repo_config` from `config !== undefined`. A
  // repo config OR any user override means "configured"; a bare preset with no
  // override returns undefined so the column stays false.
  const configured =
    seeded.hasRepoConfig ||
    ctx.focus !== undefined ||
    (ctx.invariants?.length ?? 0) > 0 ||
    (ctx.categories?.length ?? 0) > 0 ||
    (ctx.scope !== undefined && ctx.scope.hosts.length > 0);
  return configured ? ctx : undefined;
}

// ── Credential preflight (Part 12, INV-33) ───────────────────────────────

/**
 * One declared 1Password credential reference (Part 12 §Config schema). The
 * shared wire type (`SecurityConfigCredentialDeclWire` in
 * `../wire/types.ts`): the setup page's wizard (`CredentialDraft`) and
 * this preflight both import it, so a user-entered credential threads
 * through with no rename at either seam.
 */
export type SecurityConfigCredentialDecl = SecurityConfigCredentialDeclWire;

/** Why a declared credential refused preflight: one of the six
 * `OnePasswordAuthError.kind` values (INV-33), or `shape_failed` when the
 * reference resolved but the value did not match its `kind`'s shape rule. */
export type SecurityCredentialPreflightReason = OnePasswordErrorKind | "shape_failed";

/**
 * A declared credential failed preflight. The corrective error `seedSecurityReview`
 * throws instead of returning a seeded result (Part 12 §Preflight validation).
 * `message` and every field here are safe to log and to show a user: none of
 * them ever carries a byte of the resolved value (INV-37).
 */
export class SecurityCredentialPreflightError extends Error {
  constructor(
    /** The failing credential's declared label. */
    public readonly label: string,
    /** The failing credential's declared `op://` reference. */
    public readonly ref: string,
    /** Why it failed: an auth-error kind, or `shape_failed`. */
    public readonly reason: SecurityCredentialPreflightReason,
    /** The corrective action a human can take. Never the resolved value. */
    public readonly remedy: string,
  ) {
    super(`credential "${label}" (${ref}) failed preflight: ${remedy}`);
    this.name = "SecurityCredentialPreflightError";
  }
}

/**
 * The corrective action for each way 1Password can refuse a reference
 * (INV-33). One remedy per `OnePasswordAuthError.kind`, and every one of them
 * names what a human does next. `scopesTried` names the scopes the resolve
 * walked, which the two token-related remedies quote.
 */
const REMEDIES: Record<OnePasswordErrorKind, (decl: SecurityConfigCredentialDecl, scopesTried: string) => string> = {
  no_token: (_decl, scopesTried) =>
    `No 1Password token is connected for any scope tried (${scopesTried}). Connect a token in ` +
    "Organization > 1Password.",
  disabled: (decl) =>
    "Personal 1Password vaults are disabled for this org. Enable Organization > 1Password > " +
    `Allow personal, or move "${decl.label}" to an org or team vault.`,
  scope: (_decl, scopesTried) =>
    `None of the scopes tried (${scopesTried}) can read this reference. Move the item to a vault ` +
    "one of those scopes' tokens can read, or pick a different scope.",
  reference: (decl) =>
    `The reference for "${decl.label}" did not resolve. The 1Password item may have been deleted ` +
    "or renamed. Update the reference.",
  ambiguous: (decl) =>
    `The reference for "${decl.label}" matches more than one 1Password item. Add a section ` +
    "segment: op://vault/item/section/field.",
  sdk: (decl) =>
    `1Password refused the resolve request for "${decl.label}". Rotate the token in ` +
    "Organization > 1Password.",
};

/** The owner context `onePasswordScopesFor` reads to order the preflight's
 * resolve scopes (team-owned, user-owned, or org-only). */
export interface CredentialPreflightCtx {
  orgId: string;
  userId: string;
  ownerType?: string;
  teamId?: string;
}

const NETSCAPE_COOKIE_LINE = /^[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]*$/m;
const PEM_PRIVATE_KEY = /-----BEGIN (RSA |EC )?PRIVATE KEY-----/;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----/;
const HEX_BYTES = /^[0-9a-fA-F]{32,}$/;

/**
 * Preflight-resolve and shape-check every declared credential (Part 12
 * §Preflight validation). Resolves `reference` through `onePassword`, using
 * the scopes `onePasswordScopesFor(ctx.ownerType, ctx.teamId)` orders, then
 * checks the resolved value's shape against `kind`, then drops the value.
 * Returns the validated decls unchanged (references only, INV-37) on
 * success; throws `SecurityCredentialPreflightError` on the first failure.
 *
 * The scope walk is the one the sandbox broker runs at runtime,
 * `resolveAcrossScopes`, so a reference that passes preflight is a reference
 * the running engagement can resolve.
 */
export async function preflightCredentials(
  decls: readonly SecurityConfigCredentialDecl[],
  ctx: CredentialPreflightCtx,
  onePassword: Pick<OnePasswordService, "resolveReference">,
): Promise<SecurityConfigCredentialDecl[]> {
  if (decls.length === 0) return [];

  const scopes = onePasswordScopesFor(ctx.ownerType, ctx.teamId);
  const opCtx: OnePasswordCtx = { orgId: ctx.orgId, userId: ctx.userId, ...(ctx.teamId ? { teamId: ctx.teamId } : {}) };
  const validated: SecurityConfigCredentialDecl[] = [];

  for (const decl of decls) {
    if (!isOnePasswordReference(decl.reference)) {
      throw new SecurityCredentialPreflightError(
        decl.label,
        decl.reference,
        "reference",
        `Reference "${decl.reference}" is not a valid op:// path. Use op://vault/item/field or ` +
          "op://vault/item/section/field.",
      );
    }

    const primary = await resolveAcrossScopes(onePassword, scopes, opCtx, decl.reference);
    if (!("value" in primary)) throw preflightFailure(decl, decl.reference, primary.attempts);
    shapeCheckByKind(decl, primary.value);

    // `mtls` MAY carry a separate certificate reference (Part 12 §Credential
    // shape and delivery). Resolve and check it the same way, under the same
    // scopes; a failure here refuses the seed exactly like the primary ref.
    const certRef = decl.kind === "mtls" ? decl.meta?.certRef : undefined;
    if (typeof certRef === "string") {
      if (!isOnePasswordReference(certRef)) {
        throw new SecurityCredentialPreflightError(
          decl.label,
          certRef,
          "reference",
          `The mtls cert reference "${certRef}" is not a valid op:// path. Use ` +
            "op://vault/item/field.",
        );
      }
      const cert = await resolveAcrossScopes(onePassword, scopes, opCtx, certRef);
      if (!("value" in cert)) throw preflightFailure(decl, certRef, cert.attempts);
      if (!PEM_CERTIFICATE.test(cert.value)) {
        throw shapeFailed(decl, "the mtls cert reference did not resolve to a PEM certificate");
      }
    }

    validated.push({ ...decl });
  }

  return validated;
}

/**
 * Turns a failed resolve into the corrective error INV-33 requires.
 * `reference` is whichever reference actually failed (the credential's
 * primary reference, or its `mtls` cert reference), so the remedy names the
 * right value.
 *
 * Which attempt to report: a scope with no token or a disabled toggle had
 * nothing to offer, and reporting it sends the reader to connect a token
 * when an earlier scope already said the reference itself is wrong. So the
 * FIRST attempt that says something else wins, and the last attempt answers
 * only when every scope was empty-handed. A failure that is not a 1Password
 * refusal names no corrective action for this credential, so it is rethrown
 * as it arrived.
 */
function preflightFailure(
  decl: SecurityConfigCredentialDecl,
  reference: string,
  attempts: readonly ScopeResolveAttempt[],
): SecurityCredentialPreflightError {
  const refusals: OnePasswordAuthError[] = [];
  for (const attempt of attempts) {
    if (!(attempt.error instanceof OnePasswordAuthError)) throw attempt.error;
    refusals.push(attempt.error);
  }
  const reported =
    refusals.find((err) => err.kind !== "no_token" && err.kind !== "disabled") ??
    refusals[refusals.length - 1] ??
    new OnePasswordAuthError("no 1Password scope was available to try", "no_token");
  const scopesTried = attempts.length > 0 ? attempts.map((a) => a.scope).join(", ") : "(none)";
  return new SecurityCredentialPreflightError(
    decl.label,
    reference,
    reported.kind,
    REMEDIES[reported.kind](decl, scopesTried),
  );
}

function shapeFailed(decl: SecurityConfigCredentialDecl, rule: string): SecurityCredentialPreflightError {
  return new SecurityCredentialPreflightError(
    decl.label,
    decl.reference,
    "shape_failed",
    `Credential "${decl.label}" (kind ${decl.kind}) failed its shape check: ${rule}. ` +
      "Store a value of that shape in 1Password, or declare the kind the value has.",
  );
}

/**
 * Checks the resolved value's shape against `decl.kind` (Part 12 §Preflight
 * validation, step 3). Never includes a byte of `value` in a thrown message.
 */
function shapeCheckByKind(decl: SecurityConfigCredentialDecl, value: string): void {
  switch (decl.kind) {
    case "password":
      if (value.length === 0) throw shapeFailed(decl, "the resolved password is empty");
      return;
    case "session":
      if (!NETSCAPE_COOKIE_LINE.test(value)) {
        throw shapeFailed(decl, "the resolved value has no Netscape cookie-jar line");
      }
      return;
    case "headerToken":
      if (value.length < 8) {
        throw shapeFailed(decl, `the resolved token is ${value.length} bytes; the minimum is 8`);
      }
      return;
    case "mtls":
      if (!PEM_PRIVATE_KEY.test(value)) {
        throw shapeFailed(decl, "the resolved value has no PEM private-key marker");
      }
      return;
    case "signingKey":
      if (!value.includes("-----BEGIN ") && !HEX_BYTES.test(value)) {
        throw shapeFailed(decl, "the resolved value is neither a PEM key nor hex bytes");
      }
      return;
    case "toolAuth":
      if (decl.refShape === "json") {
        try {
          JSON.parse(value);
        } catch {
          throw shapeFailed(decl, "the resolved value did not parse as JSON");
        }
      } else if (value.length === 0) {
        throw shapeFailed(decl, "the resolved value is empty");
      }
      return;
    case "testData":
      if (value.length === 0) throw shapeFailed(decl, "the resolved value is empty");
      return;
  }
}
