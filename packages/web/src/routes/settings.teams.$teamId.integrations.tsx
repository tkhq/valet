import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "./integrations";

/** A team's Integrations. The team layout pins the team's scope. */
export const Route = createFileRoute("/settings/teams/$teamId/integrations")({
  component: IntegrationsPage,
});
