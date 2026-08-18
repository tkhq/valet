import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { usePlugins } from "~/api/integrations";
import { Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { hasVisibleSurface, IntegrationRow, isService } from "~/components/integrations/integration-row";
import { pluginDisplayName } from "~/components/integrations/display-name";

/**
 * `/integrations` — the services a person can connect, in the settings
 * visual idiom (open hairline stacks, no card boxes). Content-only plugins
 * are not listed: they need no credential and offer no action, so a row for
 * one was a row nobody could use. OAuth connect for services declaring
 * `oauth` metadata redirects
 * to `/api/credentials/:service/connect` and lands back here with
 * `?connected=` or `?error=`; manual token entry remains the fallback for
 * everything else.
 */
export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
});

type ConnectResult = { kind: "connected" | "error"; value: string } | null;

/**
 * Reads the OAuth round trip's result, then clears it from the URL so a
 * reload does not repeat the notice. The read is an effect, not a `useState`
 * initializer: `replaceState` is a side effect, and React runs an
 * initializer during render — twice under StrictMode. The effect also runs
 * after the first paint, so the live region below is already on the page
 * when its text arrives. A screen reader announces the notice only in that
 * order.
 */
function useConnectResult(): ConnectResult {
  const [result, setResult] = useState<ConnectResult>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    window.history.replaceState(null, "", window.location.pathname);
    setResult(
      connected
        ? { kind: "connected", value: connected }
        : { kind: "error", value: error ?? "" },
    );
  }, []);

  return result;
}

export function IntegrationsPage() {
  const { data, isLoading, error } = usePlugins();
  const plugins = data?.plugins ?? [];
  const connectResult = useConnectResult();

  // `hasVisibleSurface` drops plugins whose every service is unconfigured,
  // unconnected, and unfixable by this caller — nothing on such a tile could
  // work, and nothing on it would tell the reader what to do. An org admin
  // keeps the tile, because the API tells them which setting is missing.
  const services = plugins
    .filter(isService)
    .filter(hasVisibleSurface)
    .sort((a, b) => pluginDisplayName(a).localeCompare(pluginDisplayName(b)));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Integrations</h1>

        {/* The live region is on the page from the first paint, and stays
            empty until the connect result arrives. A screen reader ignores a
            region that appears together with its text. */}
        <div role="status">
          {connectResult?.kind === "connected" && (
            <div className="mt-4 rounded border border-line bg-moss-wash px-3 py-2 text-sm text-ink">
              Connected {connectResult.value}.
            </div>
          )}
          {connectResult?.kind === "error" && (
            <div className="mt-4 rounded border border-line bg-danger-wash px-3 py-2 text-sm text-danger-600">
              Connection failed: {connectResult.value}. Select Connect on the service below to
              try again.
            </div>
          )}
        </div>

        <div className="mt-10 space-y-12">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading integrations…
            </div>
          )}
          {!isLoading && error && (
            <div className="text-sm text-danger-500">
              Couldn't load integrations. Check that the server is running, then reload.
            </div>
          )}
          {!isLoading && !error && plugins.length === 0 && (
            <div className="text-sm text-muted">No plugins installed.</div>
          )}

          {!isLoading && !error && services.length > 0 && (
            <Section title="Services" description="Most need a key to connect.">
              <div className="grid gap-3 pt-4 sm:grid-cols-2">
                {services.map((plugin) => (
                  <IntegrationRow key={plugin.name} plugin={plugin} />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
