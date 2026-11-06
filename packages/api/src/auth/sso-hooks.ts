/**
 * SSO comes only from the deployment's `AUTH_OIDC_*` settings (`defaultSSO` in
 * index.ts). `@better-auth/sso` also lets any signed-in user register, edit and
 * list providers stored in the database, and sign-in falls back to those rows
 * by provider id or email domain. The api then fetches a stored provider's
 * token and userinfo URLs from inside the cluster, and the plugin checks those
 * URLs only by hostname when they are saved. This hook refuses every SSO route
 * except sign-in and callback for the configured provider.
 */
import { APIError } from "better-auth/api";

/** Provider id of the deployment's OIDC provider: `defaultSSO` and the login page use it. */
export const OIDC_PROVIDER_ID = "oidc";

export const SSO_ROUTE_REFUSED_MESSAGE =
  "SSO is set by the deployment (AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, AUTH_OIDC_CLIENT_SECRET), not through the API.";

export interface SsoHookContext {
  /** Route template, e.g. `/sso/callback/:providerId`. */
  path?: string;
  body?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
}

export function guardSsoRoutes(ctx: SsoHookContext, oidcConfigured: boolean): void {
  const path = ctx.path;
  if (path !== "/sign-in/sso" && !path?.startsWith("/sso/")) return;
  if (oidcConfigured) {
    if (path === "/sign-in/sso" && ctx.body?.providerId === OIDC_PROVIDER_ID) return;
    if (path === "/sso/callback/:providerId" && ctx.params?.providerId === OIDC_PROVIDER_ID) return;
    // The shared callback reads its provider from the state that sign-in stored.
    if (path === "/sso/callback") return;
  }
  throw new APIError("FORBIDDEN", { message: SSO_ROUTE_REFUSED_MESSAGE });
}
