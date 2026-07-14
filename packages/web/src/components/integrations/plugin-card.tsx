/**
 * One plugin's card on `/integrations` (Task 15): name, description, action
 * count, then a service row per declared credential. Plugins with no
 * `credentials` declarations (`services: []`) still list — nothing to
 * connect, so the card just shows its manifest info.
 */
import type { PluginSummary } from "@valet/api/wire";
import { Card, CardBody, CardHeader, CardTitle } from "~/components/primitives";
import { ServiceRow } from "./service-row";

export function PluginCard({ plugin }: { plugin: PluginSummary }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle>{plugin.name}</CardTitle>
          {plugin.description && <p className="mt-0.5 text-xs text-muted">{plugin.description}</p>}
        </div>
        <span className="shrink-0 text-xs text-muted font-mono">
          {plugin.actionCount} action{plugin.actionCount === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {plugin.services.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted">Nothing to connect for this plugin.</div>
        ) : (
          <ul className="divide-y divide-line">
            {plugin.services.map((service) => (
              <ServiceRow key={service.service} service={service} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
