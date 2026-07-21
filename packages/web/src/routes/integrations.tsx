import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { usePlugins } from "~/api/integrations";
import { Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { IntegrationRow, BuiltInRow, isService } from "~/components/integrations/integration-row";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/integrations` — what the assistant can reach. Two groups in the
 * settings visual idiom (open hairline stacks, no card boxes): Services
 * (plugins with tools and/or credentials — connectable) and Built in
 * (content-only plugins that just work). OAuth connect for services
 * declaring `oauth` metadata redirects to `/api/credentials/:service/connect`
 * and lands back here with `?connected=` or `?error=`; manual token entry
 * remains the fallback for everything else.
 */
export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
});

type ConnectResult = { kind: "connected" | "error"; value: string } | null;

function useConnectResult(): ConnectResult {
  const [result] = useState<ConnectResult>(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return null;
    window.history.replaceState(null, "", window.location.pathname);
    return connected
      ? ({ kind: "connected", value: connected } as const)
      : ({ kind: "error", value: error ?? "" } as const);
  });
  return result;
}

export function IntegrationsPage() {
  const { data, isLoading, error } = usePlugins();
  const plugins = data?.plugins ?? [];
  const connectResult = useConnectResult();

  const services = plugins
    .filter(isService)
    .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)));
  const builtIn = plugins
    .filter((p) => !isService(p))
    .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Integrations</h1>
        <p className="mt-1 text-sm text-muted">
          What your assistant can reach. Connect a service with a key; built-in abilities just
          work.
        </p>

        {connectResult?.kind === "connected" && (
          <div
            role="status"
            className="mt-4 rounded border border-moss/30 bg-moss/10 px-3 py-2 text-sm text-ink"
          >
            Connected {connectResult.value}.
          </div>
        )}
        {connectResult?.kind === "error" && (
          <div
            role="status"
            className="mt-4 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600"
          >
            Connection failed: {connectResult.value}
          </div>
        )}

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
            <Section
              title="Services"
              description="Tools your assistant uses on your behalf — most need a key to connect."
            >
              <ul className="divide-y divide-line">
                {services.map((plugin) => (
                  <IntegrationRow key={plugin.name} plugin={plugin} />
                ))}
              </ul>
            </Section>
          )}

          {!isLoading && !error && builtIn.length > 0 && (
            <Section title="Built in" description="Always available — nothing to set up.">
              <ul className="divide-y divide-line">
                {builtIn.map((plugin) => (
                  <BuiltInRow key={plugin.name} plugin={plugin} />
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
