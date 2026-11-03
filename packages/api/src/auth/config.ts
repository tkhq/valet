/**
 * Auth configuration loader.
 * Parses environment variables into a typed AuthConfig object.
 * Pure function — no process.env reads inside the module.
 */

/** Better Auth's documented default session lifetime, made explicit for eligibility expiry. */
export const AUTH_SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

/** A way to sign in. A deployment turns each one on in `AUTH_METHODS`. */
export type LoginMethod = "password" | "oidc" | "google" | "github";

export const LOGIN_METHODS: readonly LoginMethod[] = ["password", "oidc", "google", "github"];

export interface AuthConfig {
  /** The sign-in methods this deployment offers, from `AUTH_METHODS`. Empty
   * means nobody can sign in: login is off until a deployment lists a method. */
  methods: LoginMethod[];
  /** The method the login page shows first, from `AUTH_PRIMARY_METHOD`, or
   * the first listed method. Null when no method is on. */
  primaryMethod: LoginMethod | null;
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  allowedEmailDomains: string[];
  /**
   * `AUTH_ADMIN_EMAILS`, lowercased: the deployment's administrators. Each
   * becomes an org admin on SSO sign-in, or on Google/GitHub sign-in with a
   * provider-verified email. Password sign-up cannot claim one without the
   * one-time admin code (`auth/bootstrap-admin.ts`). Nobody is demoted when
   * an email leaves the list.
   */
  adminEmails?: string[];
  /** Explicit deployment opt-in: admit new users without invitations. */
  allowSignup?: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    name: string;
    domain: string;
    /**
     * Claim that carries the user's full group paths, e.g.
     * `["/platform/admins", "/research"]`. The team sync mirrors those
     * groups into teams (`services/team-sync.ts`).
     */
    teamClaim: string;
    /**
     * Claim whose presence proves the group mapper ran. Any value counts.
     *
     * Keycloak sends no group claim at all for a user who is in no groups,
     * so "in no groups" and "no mapper configured" arrive identical. The
     * sync must tell them apart: the first empties the user's teams, the
     * second must change nothing. This marker is the only thing that
     * separates them.
     */
    teamAssertedClaim: string;
    /** Sub-group name that grants admin on the parent team, e.g. `admins`. */
    teamAdminGroup: string;
    // The mirrored-group allowlist is NOT here. It lives on the org row
    // (`orgs.sso_team_groups`), where Settings edits it and the boot
    // reconciler writes `auth.sso.teams.groups` over it at every start
    // (`services/config-reconcile.ts`). The login sync and the boot report
    // read that column, so this boot-time snapshot has no reader.
  };
  social: {
    google?: {
      clientId: string;
      clientSecret: string;
    };
    github?: {
      clientId: string;
      clientSecret: string;
    };
  };
  sandboxJwtMaster: string;
}

/** Parses `AUTH_ADMIN_EMAILS`: comma-separated, trimmed, lowercased, deduplicated. */
export function parseAdminEmails(raw: string | undefined): string[] {
  const emails = (raw ?? "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0);
  for (const email of emails) {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) {
      throw new Error(
        `AUTH_ADMIN_EMAILS has "${email}", which is not an email address. ` +
        `Set AUTH_ADMIN_EMAILS to a comma-separated list of administrator emails, then restart the api.`,
      );
    }
  }
  return [...new Set(emails)];
}

/** Reads an optional variable, treating whitespace-only as unset. */
function trimmedOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Reports the stub-vs-real auth conflict, or null when the environment is
 * coherent. The stub identity (`LOCAL_USER`) is a seeded admin, so a
 * deployment that sets both variables answers every credential-less request
 * with admin access. The API refuses to boot on this pair; a confusing
 * configuration must fail loudly, not grant admin quietly.
 */
export function authModeConflict(env: NodeJS.ProcessEnv): string | null {
  if (!env.BETTER_AUTH_SECRET || env.VALET_LOCAL_AUTH !== "1") {
    return null;
  }
  return (
    "BETTER_AUTH_SECRET and VALET_LOCAL_AUTH=1 are mutually exclusive: the local stub identity is an admin, " +
    "so credential-less requests would get admin access. Unset VALET_LOCAL_AUTH to use real auth, " +
    "or unset BETTER_AUTH_SECRET to use the local dev stub."
  );
}

/**
 * Loads and validates auth configuration from environment variables.
 * Returns null if BETTER_AUTH_SECRET is not set (stub-only mode).
 * Throws if any provider configuration is incomplete.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    return null;
  }

  // baseUrl: BETTER_AUTH_URL with default
  const baseUrl = env.BETTER_AUTH_URL ?? "http://localhost:8788";

  // trustedOrigins: always includes localhost:5173, appends AUTH_TRUSTED_ORIGINS
  const trustedOrigins = ["http://localhost:5173"];
  if (env.AUTH_TRUSTED_ORIGINS) {
    const origins = env.AUTH_TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    trustedOrigins.push(...origins);
  }

  // allowedEmailDomains: lowercased, trimmed; empty array when unset
  const allowedEmailDomains: string[] = [];
  if (env.AUTH_ALLOWED_EMAIL_DOMAINS) {
    const domains = env.AUTH_ALLOWED_EMAIL_DOMAINS.split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);
    allowedEmailDomains.push(...domains);
  }

  // adminEmails: lowercased; a malformed entry stops boot instead of
  // silently leaving the deployment without its intended admin.
  const adminEmails = parseAdminEmails(env.AUTH_ADMIN_EMAILS);

  // OIDC configuration: requires all three (issuer, clientId, clientSecret) or none
  let oidc: AuthConfig["oidc"] | undefined;
  const oidcIssuer = env.AUTH_OIDC_ISSUER;
  const oidcClientId = env.AUTH_OIDC_CLIENT_ID;
  const oidcClientSecret = env.AUTH_OIDC_CLIENT_SECRET;

  const oidcCount = [oidcIssuer, oidcClientId, oidcClientSecret].filter(
    (v) => v !== undefined && v !== "",
  ).length;

  if (oidcCount === 0) {
    // No OIDC config: valid
  } else if (oidcCount === 3 && oidcIssuer && oidcClientId && oidcClientSecret) {
    // All OIDC vars set: valid, parse them
    const issuerUrl = new URL(oidcIssuer);
    const defaultDomain = issuerUrl.hostname;
    const domain = env.AUTH_OIDC_DOMAIN ?? defaultDomain;
    const name = env.AUTH_OIDC_NAME ?? "SSO";

    // Team-sync claim names. The defaults match the mappers in
    // `docker/keycloak/valet-realm.json`, and `groups` is also the name
    // Keycloak's stock group mapper uses — so these defaults DO name a claim
    // a real provider sends. What turns the sync on is neither of them: it
    // is the `ssoTeamSync` org feature gate, which is off until an operator
    // sets it (`services/org.ts`, read in `auth/provisioning.ts`).
    //
    // These three reads are the FALLBACK layer. `valet.yaml` is the preferred
    // home for the mapping (`auth.sso.teams`), and `main.ts` overwrites the
    // values below with `resolveSsoTeamMapping` when the file declares them.
    // A deployment that sets both is refused at boot, one field at a time.
    const teamClaim = trimmedOr(env.AUTH_OIDC_TEAM_CLAIM, "groups");
    const teamAssertedClaim = trimmedOr(env.AUTH_OIDC_TEAM_ASSERTED_CLAIM, "groups_asserted");
    const teamAdminGroup = trimmedOr(env.AUTH_OIDC_TEAM_ADMIN_GROUP, "admins");

    oidc = {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      name,
      domain,
      teamClaim,
      teamAssertedClaim,
      teamAdminGroup,
    };
  } else {
    // Partial OIDC config: invalid
    const missing: string[] = [];
    if (!oidcIssuer) missing.push("AUTH_OIDC_ISSUER");
    if (!oidcClientId) missing.push("AUTH_OIDC_CLIENT_ID");
    if (!oidcClientSecret) missing.push("AUTH_OIDC_CLIENT_SECRET");
    throw new Error(
      `OIDC configuration is incomplete. Set all three or none: ${missing.join(", ")}`,
    );
  }

  // Google OAuth: requires both clientId and clientSecret or neither
  let googleConfig: { clientId: string; clientSecret: string } | undefined;
  const googleClientId = env.AUTH_GOOGLE_CLIENT_ID;
  const googleClientSecret = env.AUTH_GOOGLE_CLIENT_SECRET;

  const googleCount = [googleClientId, googleClientSecret].filter(
    (v) => v !== undefined && v !== "",
  ).length;

  if (googleCount === 0) {
    // No Google config: valid
  } else if (googleCount === 2 && googleClientId && googleClientSecret) {
    // Both Google vars set: valid
    googleConfig = {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    };
  } else {
    // Partial Google config: invalid
    const missing: string[] = [];
    if (!googleClientId) missing.push("AUTH_GOOGLE_CLIENT_ID");
    if (!googleClientSecret) missing.push("AUTH_GOOGLE_CLIENT_SECRET");
    throw new Error(
      `Google OAuth configuration is incomplete. Set both or neither: ${missing.join(", ")}`,
    );
  }

  // GitHub OAuth: requires both clientId and clientSecret or neither
  let githubConfig: { clientId: string; clientSecret: string } | undefined;
  const githubClientId = env.AUTH_GITHUB_CLIENT_ID;
  const githubClientSecret = env.AUTH_GITHUB_CLIENT_SECRET;

  const githubCount = [githubClientId, githubClientSecret].filter(
    (v) => v !== undefined && v !== "",
  ).length;

  if (githubCount === 0) {
    // No GitHub config: valid
  } else if (githubCount === 2 && githubClientId && githubClientSecret) {
    // Both GitHub vars set: valid
    githubConfig = {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
    };
  } else {
    // Partial GitHub config: invalid
    const missing: string[] = [];
    if (!githubClientId) missing.push("AUTH_GITHUB_CLIENT_ID");
    if (!githubClientSecret) missing.push("AUTH_GITHUB_CLIENT_SECRET");
    throw new Error(
      `GitHub OAuth configuration is incomplete. Set both or neither: ${missing.join(", ")}`,
    );
  }

  // sandboxJwtMaster: defaults to secret if not set
  const sandboxJwtMaster = env.VALET_SANDBOX_JWT_MASTER ?? secret;

  const { methods, primaryMethod } = parseLoginMethods(env, {
    oidc: oidc !== undefined,
    google: googleConfig !== undefined,
    github: githubConfig !== undefined,
  });

  return {
    methods,
    primaryMethod,
    secret,
    baseUrl,
    trustedOrigins,
    allowedEmailDomains,
    ...(adminEmails.length ? { adminEmails } : {}),
    ...(env.AUTH_ALLOW_SIGNUP === "1" ? { allowSignup: true } : {}),
    // A provider with credentials but no place in AUTH_METHODS stays off.
    ...(methods.includes("oidc") ? { oidc } : {}),
    social: {
      ...(googleConfig && methods.includes("google") && { google: googleConfig }),
      ...(githubConfig && methods.includes("github") && { github: githubConfig }),
    },
    sandboxJwtMaster,
  };
}

/**
 * Reads `AUTH_METHODS` (a comma list of `password`, `oidc`, `google`,
 * `github`) and `AUTH_PRIMARY_METHOD`. Login is off by default: a deployment
 * turns on each method by name, so credentials alone never open a door. The
 * one default: with `AUTH_METHODS` unset and OIDC configured, SSO alone is on. A
 * listed provider without its credentials stops the boot, so a typo cannot
 * leave everyone locked out without a message.
 */
export function parseLoginMethods(
  env: NodeJS.ProcessEnv,
  configured: { oidc: boolean; google: boolean; github: boolean },
): { methods: LoginMethod[]; primaryMethod: LoginMethod | null } {
  // Unset (not empty) with SSO configured means SSO alone: an SSO deployment
  // keeps working, with no password, before its config names a method. Any
  // other unset case turns login off, and an empty value always does.
  const raw = env.AUTH_METHODS ?? (configured.oidc ? "oidc" : "");
  const listed = raw.split(",").map((m) => m.trim().toLowerCase()).filter((m) => m.length > 0);
  const unknown = listed.filter((m) => !LOGIN_METHODS.includes(m as LoginMethod));
  if (unknown.length > 0) {
    throw new Error(`AUTH_METHODS has unknown methods: ${unknown.join(", ")}. Use ${LOGIN_METHODS.join(", ")}.`);
  }
  // Narrowed by the check above; deduplicated in the order listed.
  const methods = [...new Set(listed as LoginMethod[])];
  const missing: Record<Exclude<LoginMethod, "password">, string> = {
    oidc: "AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, and AUTH_OIDC_CLIENT_SECRET",
    google: "AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET",
    github: "AUTH_GITHUB_CLIENT_ID and AUTH_GITHUB_CLIENT_SECRET",
  };
  for (const method of methods) {
    if (method !== "password" && !configured[method]) {
      throw new Error(`AUTH_METHODS turns on ${method}, but it is not configured. Set ${missing[method]}, or remove ${method} from AUTH_METHODS.`);
    }
  }
  const primary = env.AUTH_PRIMARY_METHOD?.trim().toLowerCase();
  if (primary && !methods.includes(primary as LoginMethod)) {
    throw new Error(`AUTH_PRIMARY_METHOD is ${primary}, which AUTH_METHODS does not turn on. Add it to AUTH_METHODS, or choose one of: ${methods.join(", ") || "(none)"}.`);
  }
  return { methods, primaryMethod: (primary as LoginMethod | undefined) ?? methods[0] ?? null };
}
