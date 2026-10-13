import { createFileRoute } from "@tanstack/react-router";
import { AccessSections } from "./settings.api-keys";

/** A team's API keys and proxy. The team layout pins the team's scope. */
export const Route = createFileRoute("/settings/teams/$teamId/access")({
  component: AccessSections,
});
