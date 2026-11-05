import { createFileRoute } from "@tanstack/react-router";
import { PoliciesPage } from "./settings.policies";

/** A team's policies. The team layout pins the team's scope. */
export const Route = createFileRoute("/settings/teams/$teamId/policies")({
  component: PoliciesPage,
});
