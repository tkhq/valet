/**
 * Auth configuration loader.
 * Parses environment variables into a typed AuthConfig object.
 * Pure function — no process.env reads inside the module.
 */

export interface AuthConfig {
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  allowedEmailDomains: string[];
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
    /**
     * Top-level group paths this instance mirrors, e.g. `["/platform"]`.
     * Undefined means the deployment named no group, and the sync then
     * mirrors NOTHING — see `ReconcileOptions.mirroredGroups`.
     *
     * No environment variable sets this one. It comes from
     * `auth.sso.teams.groups` in `valet.yaml`, because a list is awkward in
     * an env var and because the boot validator uses it to reject a group
     * that would collide with a declared team name.
     */
    teamGroups?: string[];
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

  return {
    secret,
    baseUrl,
    trustedOrigins,
    allowedEmailDomains,
    oidc,
    social: {
      ...(googleConfig && { google: googleConfig }),
      ...(githubConfig && { github: githubConfig }),
    },
    sandboxJwtMaster,
  };
}
