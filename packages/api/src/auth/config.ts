/**
 * Auth configuration loader.
 * Parses environment variables into a typed AuthConfig object.
 * Pure function — no process.env reads inside the module.
 */

import type { OrgRole } from "./permissions.js";
import { isOrgRole } from "./permissions.js";

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
    roleMap?: { claimValue: string; role: OrgRole }[];
    roleClaim: string;
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

    const roleClaim = env.AUTH_OIDC_ROLE_CLAIM?.trim() || "realm_access.roles";
    let roleMap: { claimValue: string; role: OrgRole }[] | undefined;
    if (env.AUTH_OIDC_ROLE_MAP) {
      roleMap = env.AUTH_OIDC_ROLE_MAP.split(",").map((pair) => {
        const idx = pair.indexOf(":");
        const claimValue = idx === -1 ? "" : pair.slice(0, idx).trim();
        const role = idx === -1 ? "" : pair.slice(idx + 1).trim();
        if (!claimValue || !isOrgRole(role)) {
          throw new Error(
            `AUTH_OIDC_ROLE_MAP entry "${pair.trim()}" must be "<claimValue>:<admin|operator|member>"`,
          );
        }
        return { claimValue, role };
      });
    }

    oidc = {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      name,
      domain,
      roleMap,
      roleClaim,
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

  // OIDC role-map: requires OIDC to be configured
  if (env.AUTH_OIDC_ROLE_MAP && !oidc) {
    throw new Error(
      "AUTH_OIDC_ROLE_MAP requires the AUTH_OIDC_* provider to be configured",
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
