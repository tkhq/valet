/**
 * Friendly labels for plugin, service, and skill ids on `/integrations`
 * and `/skills`. The map and the fallback live in the api package
 * (`@valet/api/service-display-name`) so the labels the connect UI shows
 * and the labels the credential refusals speak cannot drift apart.
 */
import { serviceDisplayName } from "@valet/api/service-display-name";

export { serviceDisplayName as displayName };

/** The card title for a plugin: the manifest's own `displayName` when it
 * declares one (config-declared MCP servers do), else the id-derived label. */
export function pluginDisplayName(plugin: { name: string; displayName?: string }): string {
  return plugin.displayName ?? serviceDisplayName(plugin.name);
}
