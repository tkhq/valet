/**
 * The configured better-auth instance (auth-v2 design, "Architecture").
 * Pure factory — no env reads, no I/O beyond what `betterAuth()` itself
 * does. Callers (`main.ts`, the test bootstrap) resolve `AuthConfig` via
 * `loadAuthConfig` and hooks via `buildAuthHooks`, then hand both here.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, type OAuthAccessToken } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { sso } from "@better-auth/sso";
import type { AppDb } from "../lib/drizzle.js";
import {
  users,
  session,
  account,
  verification,
  ssoProvider,
  apikey,
  oauthApplication,
  oauthAccessToken,
  oauthConsent,
} from "../schema/index.js";
import type { AuthConfig } from "./config.js";
import type { OrgRole } from "./permissions.js";
import type { buildAuthHooks } from "./provisioning.js";
import { decodeJwtClaims, extractMappedRole, syncSsoOrgRole } from "./sso-role-sync.js";

export interface BuildAuthOpts {
  db: AppDb;
  cfg: AuthConfig;
  hooks: ReturnType<typeof buildAuthHooks>;
}

/**
 * Session row shape returned by `auth.api.getSession`, transcribed from
 * `better-auth`'s `api/routes/session.d.mts` (`getSession`'s success
 * branch) — the fields every deployment gets regardless of `session`
 * plugin config, since `ValetAuth` doesn't carry the `Option` type
 * parameter the real endpoint is generic over.
 */
export interface ValetAuthSession {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  expiresAt: Date;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * User row shape returned by `auth.api.getSession`, base fields plus the
 * `role`/`defaultModel` `additionalFields` this instance configures below
 * (see `buildAuth`'s `user.additionalFields`).
 */
export interface ValetAuthSessionUser {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  role: string;
  defaultModel?: string | null;
}

/**
 * `apikey` row shape returned by `auth.api.verifyApiKey`'s `key` field,
 * transcribed from `@better-auth/api-key`'s `ApiKey` type minus the
 * `key`/`configId` fields the endpoint's `Omit<ApiKey, "key">` return type
 * excludes (the hashed key value is never handed back to a caller that
 * only proved possession of the plaintext once, at creation).
 */
export interface ValetApiKeyRecord {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  referenceId: string;
  refillInterval: number | null;
  refillAmount: number | null;
  lastRefillAt: Date | null;
  enabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitTimeWindow: number | null;
  rateLimitMax: number | null;
  requestCount: number;
  remaining: number | null;
  lastRequest: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
  permissions?: Record<string, string[]> | null;
}

/** `auth.api.verifyApiKey`'s return shape (the four-way discriminated
 * union upstream collapses to this: `key` is only non-null when `valid` is
 * true, `error` only non-null when `valid` is false — callers narrow on
 * `valid`/`key` together, same as `@better-auth/api-key`'s own README
 * examples). */
export interface ValetVerifyApiKeyResult {
  valid: boolean;
  error: { message: string | undefined; code: string; cause?: unknown } | null;
  key: ValetApiKeyRecord | null;
}

/**
 * Hand-written surface, not `ReturnType<typeof betterAuth>`. The real
 * inferred instance type is two things at once, in this composite
 * (`declaration: true`) project:
 *   - Unnameable across the `.d.ts` boundary (TS2742) — it transitively
 *     reaches a `zod` v4 internal path that isn't part of `zod`'s public
 *     export map.
 *   - Structurally incompatible with the generic `Auth<BetterAuthOptions>`
 *     base (TS2322) — our `user.additionalFields` (`role` required) makes
 *     every endpoint's inferred `User` shape a strict superset of the base
 *     `User`, which fails in the contravariant (body/param) positions.
 * This interface declares only what call sites in this package actually
 * use: `handler` (the catch-all mount), the two `mcp` plugin endpoints
 * `oAuthDiscoveryMetadata`/`oAuthProtectedResourceMetadata` require
 * structurally (both declared `(...args: any) => any` upstream, so a
 * looser `unknown[]`/`unknown` signature here still satisfies their
 * generic constraint), the two endpoints the auth middleware ladder
 * (Task 7) calls directly: `getSession` (cookie/session-header auth) and
 * `verifyApiKey` (the `apiKey` plugin's key-verification endpoint), and
 * `getMcpSession` — `withMcpAuth`'s bearer-token verifier (Task 9), also
 * declared `(...args: any) => Promise<OAuthAccessToken | null>` upstream so
 * the same looser `unknown[]` signature satisfies it. `options` is
 * `withMcpAuth`'s other generic-constraint member (it reads
 * `options.basePath`/`options.baseURL` to build the `WWW-Authenticate`
 * challenge's `resource_metadata` URL) — the same config object passed
 * into `betterAuth()` below, so `BetterAuthOptions` (not a hand-narrowed
 * subset) is the honest type for it.
 * `buildAuth` casts the real instance down to it below.
 */
export interface ValetAuth {
  handler: (request: Request) => Promise<Response>;
  options: BetterAuthOptions;
  api: {
    getMcpOAuthConfig: (...args: unknown[]) => unknown;
    getMCPProtectedResource: (...args: unknown[]) => unknown;
    getMcpSession: (...args: unknown[]) => Promise<OAuthAccessToken | null>;
    getSession: (opts: {
      headers: Headers;
    }) => Promise<{ session: ValetAuthSession; user: ValetAuthSessionUser } | null>;
    verifyApiKey: (opts: { body: { key: string } }) => Promise<ValetVerifyApiKeyResult>;
  };
}

/**
 * Builds the sso plugin's `provisionUser` callback, closing over the
 * already-narrowed `roleMap`/`roleClaim` so the callback body itself needs
 * no further `cfg.oidc` narrowing (or `?? []`-style masking of the "unset"
 * case, which can't happen here — the caller only invokes this when
 * `cfg.oidc.roleMap` is set).
 *
 * Parameter type is a minimal local shape, not `@better-auth/sso`'s
 * `provisionUser` data type: `userInfo`/`token` are `Record<string, any>` /
 * loosely-typed upstream (see `SSOOptions["provisionUser"]` in
 * `@better-auth/sso`'s dist types), so a structural subset here both avoids
 * `any` leaking into our code and still satisfies the plugin's contravariant
 * parameter position.
 */
function buildProvisionUser(db: AppDb, roleMap: { claimValue: string; role: OrgRole }[], roleClaim: string) {
  return async (data: {
    user: { id: string };
    userInfo: Record<string, unknown>;
    token?: { idToken?: string };
  }): Promise<void> => {
    const idToken = data.token?.idToken;
    const role = extractMappedRole({
      roleMap,
      roleClaim,
      userInfo: data.userInfo,
      idTokenClaims: idToken ? (decodeJwtClaims(idToken) ?? undefined) : undefined,
    });
    await syncSsoOrgRole(db, data.user.id, role);
  };
}

/**
 * `oidcConfig.pkce`/`discoveryEndpoint` are required by `@better-auth/sso`'s
 * `OIDCConfig` type (unlike the DB-registered-provider API path, which
 * defaults them at runtime) — computed here from `issuer` per the standard
 * OIDC discovery-document convention, and PKCE enabled since Keycloak
 * supports it by default.
 */
export function buildAuth(opts: BuildAuthOpts): ValetAuth {
  const { db, cfg, hooks } = opts;

  const auth = betterAuth({
    secret: cfg.secret,
    baseURL: cfg.baseUrl,
    basePath: "/api/auth",
    trustedOrigins: cfg.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: users,
        session,
        account,
        verification,
        ssoProvider,
        apikey,
        oauthApplication,
        oauthAccessToken,
        oauthConsent,
      },
    }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      ...(cfg.social.google
        ? { google: { ...cfg.social.google, accessType: "offline", prompt: "select_account consent" } }
        : {}),
      ...(cfg.social.github ? { github: cfg.social.github } : {}),
    },
    user: {
      additionalFields: {
        // `defaultValue` is a deviation from the brief's literal config: a
        // `required: true, input: false` field with no default makes
        // better-auth's `parseInputData` throw `MISSING_FIELD` on every
        // signup, BEFORE `databaseHooks.user.create.before` ever runs to
        // stamp the real role (verified empirically — `role is required`,
        // `code: "MISSING_FIELD"` — not a types issue, a runtime one). The
        // hook still overwrites this default with the admission-rule role
        // on every create path (social/SSO/email); "member" here only
        // covers the brief window before that overwrite.
        role: { type: "string", required: true, input: false, defaultValue: "member" },
        defaultModel: { type: "string", required: false },
      },
    },
    hooks: { before: hooks.beforeHook },
    databaseHooks: hooks.databaseHooks,
    rateLimit: { enabled: process.env.NODE_ENV === "production" },
    plugins: [
      sso({
        trustEmailVerified: true,
        ...(cfg.oidc
          ? {
              defaultSSO: [
                {
                  providerId: "oidc",
                  domain: cfg.oidc.domain,
                  oidcConfig: {
                    clientId: cfg.oidc.clientId,
                    clientSecret: cfg.oidc.clientSecret,
                    issuer: cfg.oidc.issuer,
                    pkce: true,
                    discoveryEndpoint: `${cfg.oidc.issuer}/.well-known/openid-configuration`,
                  },
                },
              ],
              ...(cfg.oidc.roleMap
                ? {
                    provisionUser: buildProvisionUser(db, cfg.oidc.roleMap, cfg.oidc.roleClaim),
                    provisionUserOnEveryLogin: true,
                  }
                : {}),
            }
          : {}),
      }),
      apiKey({ defaultPrefix: "vlt_", rateLimit: { enabled: false } }),
      mcp({ loginPage: "/login" }),
    ],
  });

  // See `ValetAuth`'s doc comment — narrowing cast to a hand-written
  // interface, not a type disagreement we're papering over.
  return auth as ValetAuth;
}

export { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata };
