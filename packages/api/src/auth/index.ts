/**
 * The configured better-auth instance (auth-v2 design, "Architecture").
 * Pure factory — no env reads, no I/O beyond what `betterAuth()` itself
 * does. Callers (`main.ts`, the test bootstrap) resolve `AuthConfig` via
 * `loadAuthConfig` and hooks via `buildAuthHooks`, then hand both here.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
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
import type { buildAuthHooks } from "./provisioning.js";

export interface BuildAuthOpts {
  db: AppDb;
  cfg: AuthConfig;
  hooks: ReturnType<typeof buildAuthHooks>;
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
 * use: `handler` (the catch-all mount) and the two `mcp` plugin endpoints
 * `oAuthDiscoveryMetadata`/`oAuthProtectedResourceMetadata` require
 * structurally (both declared `(...args: any) => any` upstream, so a
 * looser `unknown[]`/`unknown` signature here still satisfies their
 * generic constraint). `buildAuth` casts the real instance down to it below.
 */
export interface ValetAuth {
  handler: (request: Request) => Promise<Response>;
  api: {
    getMcpOAuthConfig: (...args: unknown[]) => unknown;
    getMCPProtectedResource: (...args: unknown[]) => unknown;
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
