import type { AuthUser } from "./middleware/auth.js";
import type { SandboxPrincipal } from "./auth/sandbox-tokens.js";
import type { Providers } from "./providers/types.js";

/**
 * Hono request context shape for every route in this package.
 *
 * - `providers` is set by `providersMiddleware` at boot.
 * - `user` is set by the auth middleware ladder (`buildAuthMiddleware`) for
 *   routes mounted under `/api/*` — on the session/api-key/stub rungs only;
 *   see `requireUser`'s doc comment in `middleware/auth.ts` for why this is
 *   typed as always-present despite that.
 * - `sandbox` is set on the `x-valet-sandbox` rung only.
 */
export interface AppVariables {
  providers: Providers;
  user: AuthUser;
  sandbox?: SandboxPrincipal;
  /** Set when the request authenticated through a team-scoped API key
   * (`apikey.metadata.teamId`). Routes that resolve an orchestrator read
   * this to route to the team's assistant instead of the user's. */
  teamScope?: string;
}

export type AppEnv = { Variables: AppVariables };
