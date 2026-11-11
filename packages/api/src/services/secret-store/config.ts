/**
 * Picks the secret store provider from the environment. `VALET_SECRET_STORE`
 * names it. Unset turns the store off. A new provider adds one entry to
 * `PROVIDERS`.
 */
import type { SecretStoreProvider } from "./provider.js";
import { createTurnkeySecretStore, turnkeyConfigFromEnv } from "./turnkey.js";

const PROVIDERS: Record<string, (env: NodeJS.ProcessEnv) => SecretStoreProvider> = {
  turnkey: (env) => createTurnkeySecretStore(turnkeyConfigFromEnv(env)),
};

/** The configured provider, or null when the store is off. A bad value or
 * missing provider settings throw, so the api fails at boot and not on a
 * user's first save. */
export function secretStoreProviderFromEnv(env: NodeJS.ProcessEnv): SecretStoreProvider | null {
  const name = env.VALET_SECRET_STORE?.trim().toLowerCase();
  if (!name) return null;
  const build = PROVIDERS[name];
  if (!build) {
    throw new Error(
      `VALET_SECRET_STORE=${name} is not a known secret store. Use one of: ${Object.keys(PROVIDERS).join(", ")}. Unset it to turn the store off.`,
    );
  }
  return build(env);
}
