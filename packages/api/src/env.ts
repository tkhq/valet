import type { AuthUser } from "./middleware/auth.js";
import type { SandboxPrincipal } from "./auth/sandbox-tokens.js";
import type { Providers } from "./providers/types.js";
import type { AuthVia, RequestPrincipal } from "./lib/request-principal.js";
import type { ValetAuth } from "./auth/index.js";

/**
 * Hono request context shape for every route in this package.
 *
 * - `providers` is set by `providersMiddleware` at boot.
 * - `user` is set by the auth middleware ladder (`buildAuthMiddleware`) for
 *   routes mounted under `/api/*` — on the session/api-key/stub rungs only;
 *   see `requireUser`'s doc comment in `middleware/auth.ts` for why this is
 *   typed as always-present despite that.
 * - `principal` and `authVia` are set on those same rungs. A team `vlt_`
 *   key sets `principal` to the team and keeps `user` as the creating
 *   admin for audit.
 * - `auth` is the better-auth instance when real auth is configured.
 * - `sandbox` is set on the `x-valet-sandbox` rung only.
 */
export interface AppVariables {
  providers: Providers;
  user: AuthUser;
  principal: RequestPrincipal;
  authVia: AuthVia;
  auth?: ValetAuth;
  sandbox?: SandboxPrincipal;
}

export type AppEnv = { Variables: AppVariables };
