/**
 * The event services the editor's When section offers, and which of them
 * are connected (docs/specs/2026-10-16-presence-hub-design.md Part H
 * step 2). A service that is not connected reads greyed in the editor.
 */
import type { PluginSummary } from "@valet/api/wire";
import { isConnected } from "~/components/integrations/integration-row";
import type { WhenService } from "./wizard-preview";

/** The services the When step offers, in the order a default is picked. */
export const EVENT_SERVICES: readonly WhenService[] = ["slack", "github", "linear"];

/**
 * The When services that are connected, or null while unknown (loading or a
 * failed read). A service counts as connected when the reader connected it
 * or the organization's credential provides it, the same rule the
 * Integrations page groups by.
 */
export function connectedServices(plugins: readonly PluginSummary[] | undefined): ReadonlySet<WhenService> | null {
  if (plugins === undefined) return null;
  const connected = new Set<WhenService>();
  for (const plugin of plugins) {
    const service = EVENT_SERVICES.find((s) => s === plugin.name);
    if (service !== undefined && plugin.services.some(isConnected)) connected.add(service);
  }
  return connected;
}
