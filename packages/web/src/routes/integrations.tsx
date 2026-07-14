import { createFileRoute } from "@tanstack/react-router";
import { usePlugins } from "~/api/integrations";
import { Spinner } from "~/components/primitives";
import { PluginCard } from "~/components/integrations/plugin-card";

/**
 * `/integrations` — connect surface (plugin-system-v2 plan Task 15): one
 * card per assembled plugin, manual token entry only (no OAuth flows this
 * phase). Reached via the top nav; spartan, matching `/workflows` /
 * `/settings`'s idiom.
 */
export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
});

export function IntegrationsPage() {
  const { data, isLoading, error } = usePlugins();
  const plugins = data?.plugins ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Integrations</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading integrations…
          </div>
        )}
        {!isLoading && error && (
          <div className="text-sm text-danger-500">Failed to load integrations.</div>
        )}
        {!isLoading && !error && plugins.length === 0 && (
          <div className="text-sm text-muted">No plugins installed.</div>
        )}

        {!isLoading &&
          plugins.map((plugin) => <PluginCard key={plugin.name} plugin={plugin} />)}
      </div>
    </div>
  );
}
