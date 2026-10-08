/** Compatibility entry point for host environment defaults and existing consumers. */
import {
  createLinearService as createPluginLinearService,
  type LinearClientConfig,
  type LinearClientEnvironment,
  type LinearService,
} from "@valet/plugin-linear/service";

export * from "@valet/plugin-linear/service";

export function createLinearService(
  config: LinearClientConfig, env: LinearClientEnvironment = process.env,
): LinearService {
  return createPluginLinearService(config, env);
}
